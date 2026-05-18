import { useContext } from 'react'
import { LanguageContext, type LanguageContextValue } from './lang'

export function useLang(): LanguageContextValue {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLang must be used within LanguageProvider')
  return ctx
}
