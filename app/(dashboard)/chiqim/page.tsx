import { redirect } from 'next/navigation'

// The manual Chiqim (stock-out) page was removed: sales go through POS and
// show under Sotuvlar, write-offs go through Spisaniya. Old links land on
// the sales list instead.
export default function ChiqimRedirect() {
  redirect('/sotuvlar')
}
