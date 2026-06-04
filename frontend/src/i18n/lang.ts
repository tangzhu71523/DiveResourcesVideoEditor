import { createContext } from 'react'
import type { Lang } from './strings'

export interface LanguageContextValue {
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: string) => string
}

export const LanguageContext = createContext<LanguageContextValue | null>(null)
