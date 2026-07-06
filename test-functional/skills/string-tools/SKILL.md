---
name: string-tools
description: Reverse strings and count unique consonants. Load when the user explicitly asks to reverse a string OR count consonants in a result.
---

# string-tools

Two procedures.

## reverse(s)
Return `s` reversed character by character.
- reverse("elephant") → "tnahpele"

## count_unique_consonants(s)
Return the number of distinct consonants in `s` (case-insensitive).
Treat aeiou as vowels; everything else alphabetic is a consonant.
Digits and punctuation are ignored.
- count_unique_consonants("tnahpele") → distinct letters in s minus vowels:
  {t,n,a,h,p,e,l,e} → consonants only: {t,n,h,p,l} → **5**

Apply both procedures when invoked. Show your work briefly.
