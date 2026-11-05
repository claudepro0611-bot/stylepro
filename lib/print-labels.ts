// Prints the labels inside `container` through an isolated iframe, one 50×30mm
// label per page. Printing the live page instead breaks: the dialog is
// position:fixed, which Chrome clips to the first printed page.
export function printLabels(container: HTMLElement | null) {
  if (!container) return

  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(iframe)

  const win = iframe.contentWindow
  const doc = iframe.contentDocument
  if (!win || !doc) { iframe.remove(); return }

  const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
    .map(node => node.outerHTML)
    .join('')

  doc.open()
  doc.write(`<!doctype html><html><head><meta charset="utf-8">${styles}<style>
    @page { size: 50mm 30mm; margin: 0; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .barcode-label { break-after: page; page-break-after: always; border-radius: 0 !important; box-shadow: none !important; --tw-ring-shadow: 0 0 #0000 !important; }
    .barcode-label:last-child { break-after: auto; page-break-after: auto; }
  </style></head><body>${container.innerHTML}</body></html>`)
  doc.close()

  let printed = false
  const run = () => {
    if (printed) return
    printed = true
    win.focus()
    win.print()
    setTimeout(() => iframe.remove(), 1000)
  }
  win.addEventListener('load', run)
  setTimeout(run, 1500)
}
