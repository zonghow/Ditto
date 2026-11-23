import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingBuffer, RecordingSanitizer, MAX_RECORDING_BYTES, MAX_RECORDING_EVENTS } from '../src/recording.js';
import { AssetCache } from '../src/assets.js';
import { BrowserService } from '../src/browser.js';

const meta = { type: 4, timestamp: 1, data: { width: 1280, height: 800, href: 'https://example.com' } };
const full = { type: 2, timestamp: 2, data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } } };
const mutation = { type: 3, timestamp: 3, data: { source: 0, adds: [], removes: [], texts: [], attributes: [] } };

test('rrweb buffer supplies complete ordered checkpoints and resets without unbounded retention', () => {
  const buffer = new RecordingBuffer('tab', 'doc');
  assert.equal(buffer.append(mutation), null);
  buffer.append(meta);
  const snapshot = buffer.append(full);
  assert.equal(snapshot.type, 'rrweb-snapshot');
  assert.deepEqual(snapshot.events.map(event => event.type), [4, 2]);
  const update = buffer.append(mutation);
  assert.equal(update.firstSequence, snapshot.lastSequence + 1);
  assert.equal(buffer.snapshot().events.length, 3);
  for (let count = 0; count < MAX_RECORDING_EVENTS; count++) buffer.append(mutation);
  assert.equal(buffer.needsCheckpoint, true);
  assert.ok(buffer.events.length <= MAX_RECORDING_EVENTS);
  buffer.append(meta);
  const reset = buffer.append({ ...full, timestamp: 9 });
  assert.equal(buffer.events.length, 2);
  assert.equal(buffer.needsCheckpoint, false);
  assert.ok(reset.firstSequence > snapshot.lastSequence);
  assert.equal(buffer.append({ ...mutation, data: { source: 5, text: 'x'.repeat(MAX_RECORDING_BYTES) } }), null);
});

test('replay removes active content and rewrites assets without forwarding arbitrary private requests', () => {
  const assets = new AssetCache();
  const sanitizer = new RecordingSanitizer(assets, 'tab', 'https://example.com/app');
  const result = sanitizer.event({ ...full, data: { node: { type: 0, id: 1, childNodes: [
    { type: 2, id: 2, tagName: 'head', attributes: {}, childNodes: [
      { type: 2, id: 3, tagName: 'script', attributes: { src: 'https://evil.test/script' }, childNodes: [{ type: 3, id: 4, textContent: 'alert(1)' }] },
      { type: 2, id: 5, tagName: 'meta', attributes: { 'http-equiv': 'refresh', content: '0;url=https://evil.test' }, childNodes: [] },
    ] },
    { type: 2, id: 6, tagName: 'img', attributes: { src: 'https://example.com/private.png', onerror: 'alert(1)' }, childNodes: [] },
    { type: 2, id: 7, tagName: 'a', attributes: { href: 'javascript:alert(1)', ping: 'https://evil.test' }, childNodes: [] },
    { type: 2, id: 8, tagName: 'iframe', attributes: { src: 'https://evil.test', srcdoc: '<script>alert(1)</script>', sandbox: 'allow-scripts' }, childNodes: [] },
    { type: 2, id: 9, tagName: 'input', attributes: { type: 'hidden', value: 'secret' }, childNodes: [] },
  ] } } });
  const text = JSON.stringify(result);
  assert.equal(text.includes('evil.test'), false);
  assert.equal(text.includes('alert(1)'), false);
  assert.equal(text.includes('private.png'), false);
  assert.equal(text.includes('"value":"secret"'), false);
  assert.match(text, /allow-same-origin/);
  assert.match(text, /content-security-policy/);
  const iframeAttrs = result.data.node.childNodes[3].attributes;
  assert.equal(iframeAttrs['data-ditto-xorigin'], '1');
  assert.equal(iframeAttrs.src, undefined);
  // rrweb-snapshot renames iframe src to rr_src; ensure both src and rr_src are tagged and stripped.
  const rrSrcResult = sanitizer.event({
    type: 3, timestamp: 3, data: {
      source: 0,
      adds: [
        { parentId: 1, nextId: null, node: { type: 2, id: 10, tagName: 'iframe', attributes: { rr_src: 'https://example.com/subframe' }, childNodes: [] } },
        { parentId: 1, nextId: null, node: { type: 2, id: 11, tagName: 'iframe', attributes: { rr_src: 'https://relay.other.test/webshell?token=secret' }, childNodes: [] } },
      ],
      attributes: [{ id: 8, attributes: { rr_src: '/local-path' } }],
    },
  });
  assert.equal(JSON.stringify(rrSrcResult).includes('relay.other.test'), false);
  assert.equal(rrSrcResult.data.adds[0].node.attributes['data-ditto-xorigin'], undefined);
  assert.equal(rrSrcResult.data.adds[1].node.attributes['data-ditto-xorigin'], '1');
  assert.equal(rrSrcResult.data.adds[1].node.attributes.rr_src, undefined);
  assert.equal(rrSrcResult.data.attributes[0].attributes['data-ditto-xorigin'], null);
  const xoriginEvt = sanitizer.event({ type: 5, timestamp: 5, data: { tag: 'ditto-xorigin', payload: { visible: true, dominant: true, count: 1, leakedUrl: 'https://secret.test' } } });
  assert.deepEqual(xoriginEvt.data, { tag: 'ditto-xorigin', payload: { visible: true, dominant: true, count: 1 } });
  const url = result.data.node.childNodes[1].attributes.src;
  assert.match(url, /^\/api\/assets\/[a-f0-9]{36}$/);
  assert.equal(assets.get(url.split('/').pop()).body, null);
  assert.equal(assets.put('tab', 'https://example.com/private.png', 'image/png', Buffer.from('synthetic')), true);
  assert.equal(assets.get(url.split('/').pop()).body.toString(), 'synthetic');
  assert.equal(assets.put('tab', 'https://example.com/private.js', 'text/javascript', Buffer.from('code')), false);
  assert.equal(sanitizer.event({ type: 6, timestamp: 4, data: { code: 'arbitrary plugin' } }), null);
  assert.equal(sanitizer.event({ type: 3, timestamp: 4, data: { source: 9, commands: ['code'] } }), null);
  const validCanvas = sanitizer.event({
    type: 5, timestamp: 5,
    data: { tag: 'ditto-canvas', payload: { id: 12, width: 80, height: 40, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } },
  });
  assert.equal(validCanvas.data.tag, 'ditto-canvas');
  assert.equal(validCanvas.data.payload.id, 12);
  assert.equal(sanitizer.event({
    type: 5, timestamp: 6,
    data: { tag: 'ditto-canvas', payload: { id: 12, width: 80, height: 40, dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' } },
  }), null);

  const canvasBuffer = new RecordingBuffer('tab', 'doc');
  canvasBuffer.append(meta);
  canvasBuffer.append(full);
  canvasBuffer.append(validCanvas);
  const newerCanvas = { ...validCanvas, timestamp: 7, data: { tag: 'ditto-canvas', payload: { id: 12, width: 80, height: 40, dataUrl: 'data:image/webp;base64,UklGRg==' } } };
  canvasBuffer.append(newerCanvas);
  const canvasEvents = canvasBuffer.snapshot().events.filter(e => e.type === 5 && e.data?.tag === 'ditto-canvas');
  assert.equal(canvasEvents.length, 1);
  assert.equal(canvasEvents[0].data.payload.dataUrl, 'data:image/webp;base64,UklGRg==');
});

test('CSS assets are scoped, sanitized and bounded; closed tabs release private resource bytes', () => {
  const assets = new AssetCache();
  const css = assets.css('one', '@import "../theme.css"; .x {background:url(https://example.com/image.png)}', 'https://example.com/a/style.css');
  assert.equal(css.includes('https://'), false);
  assert.match(css, /\/api\/assets\//);
  assert.notEqual(assets.reference('one', 'https://example.com/image.png', ''), assets.reference('two', 'https://example.com/image.png', ''));
  assets.put('one', 'https://example.com/a/style.css', 'text/css', Buffer.from('body{background:url(image.png)}'));
  const id = assets.reference('one', 'https://example.com/a/style.css', '').split('/').pop();
  assert.equal(assets.get(id).body.toString().includes('image.png'), false);
  assets.removeScope('one');
  assert.equal(assets.get(id), undefined);
  assert.equal(assets.bytes, 0);
});

test('inline SVG icons, large >16KB data assets, and CSSOM #fragment references render safely', () => {
  const assets = new AssetCache();
  const sanitizer = new RecordingSanitizer(assets, 'tab', 'https://data.example.com/tea-next/overview');

  // Simulate SPA navigation before full snapshot
  sanitizer.event({ type: 4, timestamp: 1, data: { width: 1440, height: 900, href: 'https://data.example.com/tea-next/cluster-analysis/1000002' } });

  const largeSvgXml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 97 74"><defs><linearGradient id="g"><stop offset="0%"/></linearGradient></defs><path d="${'M0 0h10v10z '.repeat(2500)}"/></svg>`;
  const largeSvgDataUrl = `data:image/svg+xml;base64,${Buffer.from(largeSvgXml).toString('base64')}`;
  assert.ok(largeSvgDataUrl.length > 32768);

  const largePngDataUrl = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAUA'.repeat(900)}`;
  assert.ok(largePngDataUrl.length > 20000);

  const utf8SvgDataUrl = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6"/></svg>';
  const evilScriptSvg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
  const evilPercentSvg = 'data:image/svg+xml,<svg width="100%" xmlns="http://www.w3.org/2000/svg">%3Cscript%3Ealert(1)%3C/script%3E</svg>';
  const evilHandlerSvg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>').toString('base64')}`;
  const evilEntitySvg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#x09;script:alert(1)"></a></svg>').toString('base64')}`;

  const snap = sanitizer.event({
    type: 2,
    timestamp: 2,
    data: {
      initialOffset: { top: 0, left: 0 },
      node: {
        type: 0,
        id: 1,
        childNodes: [
          { type: 2, id: 10, tagName: 'img', attributes: { src: largeSvgDataUrl }, childNodes: [] },
          { type: 2, id: 11, tagName: 'img', attributes: { src: largePngDataUrl }, childNodes: [] },
          { type: 2, id: 12, tagName: 'img', attributes: { src: utf8SvgDataUrl }, childNodes: [] },
          { type: 2, id: 13, tagName: 'img', attributes: { src: evilScriptSvg }, childNodes: [] },
          { type: 2, id: 14, tagName: 'img', attributes: { src: evilPercentSvg }, childNodes: [] },
          { type: 2, id: 15, tagName: 'img', attributes: { src: evilHandlerSvg }, childNodes: [] },
          { type: 2, id: 16, tagName: 'img', attributes: { src: evilEntitySvg }, childNodes: [] },
          { type: 2, id: 17, tagName: 'use', attributes: { href: largeSvgDataUrl }, childNodes: [] },
          { type: 2, id: 18, tagName: 'use', attributes: { href: 'https://data.example.com/tea-next/cluster-analysis/1000002#icon-star' }, childNodes: [] },
          { type: 2, id: 19, tagName: 'use', attributes: { href: 'https://cdn.example.com/sprite.svg#icon-star' }, childNodes: [] },
          { type: 2, id: 20, tagName: 'img', attributes: { srcset: 'https://cdn.example.com/retina.png 2x' }, childNodes: [] },
          {
            type: 2,
            id: 21,
            tagName: 'style',
            attributes: {},
            childNodes: [{
              type: 3,
              id: 22,
              isStyle: true,
              textContent: [
                '.nav-st0 { fill: url("https://data.example.com/tea-next/cluster-analysis/1000002#SVGID_1_"); }',
                '.nav-st1 { fill: url("https://data.example.com/tea-next/overview#SVGID_2_"); }',
                '.nav-st2 { fill: url("https://data.example.com/tea-next/cluster-analysis/#SVGID_3_"); }',
                '.icon-bg { background-image: url(\'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>\'); }',
                `@font-face { font-family: "icon"; src: url("data:application/font-woff2;base64,${'d09GMgABAAAAAA=='.repeat(1500)}"); }`,
                `.evil-bg { background-image: url("${evilScriptSvg}"); }`,
              ].join('\n'),
            }],
          },
        ],
      },
    },
  });

  const nodes = snap.data.node.childNodes;
  assert.equal(nodes[0].attributes.src, largeSvgDataUrl);
  assert.equal(nodes[1].attributes.src, largePngDataUrl);
  assert.equal(nodes[2].attributes.src, utf8SvgDataUrl);
  for (const idx of [3, 4, 5, 6]) {
    assert.match(nodes[idx].attributes.src, /^data:image\/gif;base64,R0lGODlh/);
  }
  assert.equal(nodes[7].attributes.href, '');
  assert.equal(nodes[8].attributes.href, '#icon-star');
  assert.match(nodes[9].attributes.href, /^\/api\/assets\/[a-f0-9]{36}#icon-star$/);
  assert.match(nodes[10].attributes.src, /^\/api\/assets\/[a-f0-9]{36}$/);

  const cssOut = nodes[11].childNodes[0].textContent;
  assert.match(cssOut, /url\("#SVGID_1_"\)/);
  assert.match(cssOut, /url\("#SVGID_2_"\)/);
  assert.match(cssOut, /url\("#SVGID_3_"\)/);
  assert.match(cssOut, /xmlns=%22http:\/\/www\.w3\.org\/2000\/svg%22/);
  assert.match(cssOut, /data:application\/font-woff2;base64,/);
  assert.match(cssOut, /\.evil-bg \{ background-image: url\(""\); \}/);

  assert.equal(assets.put('tab', 'https://cdn.example.com/icon.woff2', 'application/font-woff2', Buffer.from('wOF2fontbytes')), true);
  assert.equal(assets.put('tab', 'https://cdn.example.com/raw-png', 'application/octet-stream', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  assert.equal(assets.put('tab', 'https://cdn.example.com/raw-html', 'application/octet-stream', Buffer.from('<html></html>')), false);
});

test('video elements stay inert without media requests while streaming deduplicated ditto-video snapshots', async () => {
  const assets = new AssetCache();
  const sanitizer = new RecordingSanitizer(assets, 'tab', 'https://video.example.com/watch');
  const snap = sanitizer.event({
    type: 2,
    timestamp: 2,
    data: {
      initialOffset: { top: 0, left: 0 },
      node: {
        type: 0,
        id: 1,
        childNodes: [{
          type: 2,
          id: 30,
          tagName: 'video',
          attributes: {
            class: 'bpx-video',
            src: 'https://cdn.example.com/secret.mp4',
            poster: 'https://cdn.example.com/cover.jpg',
            controls: '',
            autoplay: '',
            loop: '',
            rr_mediaState: 'played',
            rr_mediaCurrentTime: 4.2,
          },
          childNodes: [
            { type: 2, id: 31, tagName: 'source', attributes: { src: 'https://cdn.example.com/alt.webm' }, childNodes: [] },
            { type: 2, id: 32, tagName: 'track', attributes: { src: 'https://cdn.example.com/subs.vtt' }, childNodes: [] },
          ],
        }],
      },
    },
  });

  const videoNode = snap.data.node.childNodes[0];
  assert.equal(videoNode.tagName, 'video');
  assert.equal(videoNode.attributes.class, 'bpx-video');
  assert.equal('src' in videoNode.attributes, false);
  assert.equal('controls' in videoNode.attributes, false);
  assert.equal('autoplay' in videoNode.attributes, false);
  assert.equal('rr_mediaState' in videoNode.attributes, false);
  assert.equal('rr_mediaCurrentTime' in videoNode.attributes, false);
  assert.match(videoNode.attributes.poster, /^\/api\/assets\/[a-f0-9]{36}$/);
  assert.deepEqual(videoNode.childNodes.map(n => n.tagName), ['noscript', 'noscript']);
  assert.equal(JSON.stringify(snap).includes('secret.mp4'), false);
  assert.equal(JSON.stringify(snap).includes('alt.webm'), false);

  const frame1 = sanitizer.event({
    type: 5,
    timestamp: 5,
    data: { tag: 'ditto-video', payload: { id: 30, width: 1280, height: 720, dataUrl: 'data:image/webp;base64,UklGRg==' } },
  });
  const frame2 = sanitizer.event({
    type: 5,
    timestamp: 6,
    data: { tag: 'ditto-video', payload: { id: 30, width: 1280, height: 720, dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' } },
  });
  assert.equal(sanitizer.event({
    type: 5,
    timestamp: 7,
    data: { tag: 'ditto-video', payload: { id: 30, width: 1280, height: 720, dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' } },
  }), null);

  const buffer = new RecordingBuffer('tab', 'doc');
  buffer.append(meta);
  buffer.append(full);
  buffer.append(frame1);
  buffer.append(frame2);
  const videoEvents = buffer.snapshot().events.filter(e => e.type === 5 && e.data?.tag === 'ditto-video');
  assert.equal(videoEvents.length, 1);
  assert.equal(videoEvents[0].data.payload.dataUrl, 'data:image/jpeg;base64,/9j/4AAQ');

  // Cross-origin tainted <video> fallback via CDP Page.captureScreenshot
  const service = new BrowserService({});
  let capturedClip = null;
  const tab = {
    id: 'tab',
    hidden: false,
    documentId: 'doc',
    page: { isClosed: () => false },
    cdp: {
      send: async (method, params) => {
        assert.equal(method, 'Page.captureScreenshot');
        capturedClip = params.clip;
        return { data: 'UklGRg==' };
      },
    },
    sanitizer,
    recording: buffer,
  };
  service.tabs.set('tab', tab);
  service.setViewer('viewer-1', 'tab', false);
  const emitted = [];
  service.on('recording', msg => emitted.push(msg));
  await service.captureTaintedVideo(tab, {
    id: 30,
    width: 1920,
    height: 1080,
    clip: { x: 100, y: 80, width: 960, height: 540 },
  });
  assert.ok(capturedClip);
  assert.equal(capturedClip.x, 100);
  assert.equal(capturedClip.width, 960);
  assert.ok(capturedClip.scale <= 720 / 960 + 0.001);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].events[0].data.tag, 'ditto-video');
  assert.equal(emitted[0].events[0].data.payload.dataUrl, 'data:image/webp;base64,UklGRg==');
});
