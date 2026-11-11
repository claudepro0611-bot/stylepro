// Open request for the Ctrl+K command palette (components/layout/CommandPalette.tsx),
// kept separate so the Sidebar can import it without an import cycle.

export const COMMAND_PALETTE_OPEN_EVENT = 'stylepro:command-palette'

/** Opens the palette from anywhere (sidebar search box, buttons). */
export function openCommandPalette() {
  window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))
}
