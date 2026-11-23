const SVG_NS = 'http://www.w3.org/2000/svg';

export function createAgentIcon(agentType) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('agent-svg');
  const path = (d, attrs = {}) => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
    svg.append(p);
  };
  if (agentType === 'claude') {
    path('M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2', {
      stroke: 'currentColor', 'stroke-width': '1.65', 'stroke-linecap': 'round',
    });
  } else if (agentType === 'codex') {
    path('M8 1.8 13.4 4.9v6.2L8 14.2 2.6 11.1V4.9L8 1.8Z', {
      stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round',
    });
    path('M5.5 6.4 7.3 8 5.5 9.6M8.7 9.8h2', {
      stroke: 'currentColor', 'stroke-width': '1.45', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
  } else if (agentType === 'opencode') {
    path('M5.6 4.2 2.2 8l3.4 3.8M10.4 4.2 13.8 8l-3.4 3.8M8.8 3.2l-1.6 9.6', {
      stroke: 'currentColor', 'stroke-width': '1.55', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
  } else if (agentType === 'cursor') {
    path('M3.2 2.6 13.2 7.2 8.5 8.8 6.8 13.4 3.2 2.6Z', {
      stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round',
    });
  } else {
    path('M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z', {
      stroke: 'currentColor', 'stroke-width': '1.4',
    });
    path('M4.6 6.2 6.8 8l-2.2 1.8M8.2 9.8h2.6', {
      stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
  }
  return svg;
}

export function createThemeIcon(mode) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const addPath = d => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.35');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  };
  if (mode === 'light') {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', '8');
    c.setAttribute('cy', '8');
    c.setAttribute('r', '2.7');
    c.setAttribute('stroke', 'currentColor');
    c.setAttribute('stroke-width', '1.35');
    svg.append(c);
    addPath('M8 2v1.3M8 12.7V14M2 8h1.3M12.7 8H14M3.75 3.75l.95.95M11.3 11.3l.95.95M12.25 3.75l-.95.95M4.7 11.3l-.95.95');
  } else if (mode === 'dark') {
    addPath('M12.6 9.8A5.2 5.2 0 0 1 6.2 3.4a5.4 5.4 0 1 0 6.4 6.4Z');
  } else {
    addPath('M2.3 3.2h11.4a.9.9 0 0 1 .9.9v6.2a.9.9 0 0 1-.9.9H2.3a.9.9 0 0 1-.9-.9V4.1a.9.9 0 0 1 .9-.9Z');
    addPath('M5.8 13.6h4.4M8 11.2v2.4');
  }
  return svg;
}

export function createHistoryIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const addPath = d => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.35');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  };
  addPath('M2.6 8a5.4 5.4 0 1 0 1.4-3.6L2.4 5.8');
  addPath('M2.4 3.2v2.6H5');
  addPath('M8 5.2V8l2 1.2');
  return svg;
}
