import { useMemo, useState, type ReactNode } from 'react'
import { STRINGS, type Lang } from './strings'
import { LanguageContext, type LanguageContextValue } from './lang'

// Locked to English — language switch removed per owner request. Kept the
// provider/useLang API so existing `t()` call-sites keep working unchanged.
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang] = useState<Lang>('en')
  const value = useMemo<LanguageContextValue>(() => ({
    lang,
    setLang: () => { /* no-op: locked to en */ },
    t: (key: string) => STRINGS.en[key] ?? key,
  }), [lang])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}
