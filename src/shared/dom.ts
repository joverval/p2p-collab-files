// Shared DOM helpers — generic, no application state

export function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

export function el(tag: string, attrs: Record<string,string>={}, kids:(string|Node)[]=[]): HTMLElement {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,v));
  kids.forEach(c=>e.append(c));
  return e;
}