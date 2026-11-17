/**
 * The kit's on-screen keyboard (0.10.0) makes room by padding the body's bottom while it's
 * open. Fixed things (the toast, the edit dialog) don't move with that padding, so mirror it
 * into `--keyboard-h` on <html> for their CSS. It's 0px whenever the keyboard is closed or off.
 */
export function trackKeyboardHeight() {
  if (typeof MutationObserver === "undefined") return;
  const sync = () => {
    const h = document.body.style.paddingBottom || "0px";
    document.documentElement.style.setProperty("--keyboard-h", h);
  };
  sync();
  new MutationObserver(sync).observe(document.body, {
    attributes: true,
    attributeFilter: ["style"],
  });
}
