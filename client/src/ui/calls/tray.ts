// Call controls that live in a tray (the "Together" and "More" popovers, the phone sheet) are hidden once you pick
// one, so anything they open (a soundboard, the share menu) anchors to the tray's own button instead.
export function trayAnchor(button: HTMLElement): HTMLElement {
  return button.closest('.call-tray')?.querySelector<HTMLElement>(':scope > .call-tray-trigger') ?? button
}
