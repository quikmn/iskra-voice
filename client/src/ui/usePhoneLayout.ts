import { useEffect, useState } from 'react'
import { PHONE_LAYOUT } from '../phoneLayout'

/** Whether the app is in its phone layout right now (src/phoneLayout.ts); follows the window and the phone turning. */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(() => typeof matchMedia === 'function' && matchMedia(PHONE_LAYOUT).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia(PHONE_LAYOUT)
    const update = () => setPhone(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return phone
}
