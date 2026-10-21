export const interfaceFontSizes = [14, 15, 16, 18] as const;
export function readInterfaceFontSize(): number {
  const size = Number(localStorage.getItem('harbor-ui-font-size'));
  return interfaceFontSizes.some(value => value === size) ? size : 15;
}
export function applyInterfaceFontSize(size: number) {
  const value = interfaceFontSizes.some(value => value === size) ? size : 15;
  document.documentElement.style.fontSize = `${value}px`;
  localStorage.setItem('harbor-ui-font-size', String(value));
}
