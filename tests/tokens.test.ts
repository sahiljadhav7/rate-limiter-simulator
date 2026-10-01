import { describe, expect, it } from 'vitest'
import tokensCss from '../src/ui/tokens.css?raw'
import designMd from '../DESIGN.md?raw'

/**
 * DESIGN.md is the source of truth for the colour tokens. src/ui/tokens.css writes each one once
 * as light-dark(<light>, <dark>), so this checks both themes against DESIGN.md's light and dark
 * blocks, and that no token is declared twice (the old copy-twice dark blocks could drift).
 */

/** Every `--name: value;` declaration in `css`, comments dropped and whitespace collapsed. */
function declarations(css: string): [string, string][] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...text.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)].map(([, name, value]) => [
    name as string,
    (value as string).replace(/\s+/g, ' ').trim(),
  ])
}

/** The text of the first rule block in `css` whose selector is exactly `selector`. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`No ${selector} block`)
  return css.slice(start, css.indexOf('\n}', start))
}

/** `value` with every light-dark(a, b) replaced by a (light) or b (dark). */
function resolve(value: string, theme: 'light' | 'dark'): string {
  return value.replace(/light-dark\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/g, (_, light, dark) =>
    theme === 'light' ? light : dark,
  )
}

const designCss = designMd.slice(
  designMd.indexOf('```css'),
  designMd.indexOf('```\n', designMd.indexOf('```css') + 6),
)
const designLight = new Map(declarations(block(designCss, ':root')))
const designDark = new Map(declarations(block(designCss, ':root[data-theme="dark"]')))
const ours = declarations(tokensCss)
const oursByName = new Map(ours)

describe('colour tokens', () => {
  it('reads every DESIGN.md block it compares against', () => {
    // A guard against a parser that finds nothing and so checks nothing.
    expect(designDark.size).toBeGreaterThan(60)
    expect(designLight.get('--bg')).toBe('#faf7f3')
    expect(designDark.get('--bg')).toBe('#16151a')
  })

  it('declares no token twice', () => {
    const names = ours.map(([name]) => name)
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([])
  })

  it.each([...designDark.keys()])('%s matches DESIGN.md in light and in dark', (name) => {
    const value = oursByName.get(name)
    expect(value, `${name} is missing from tokens.css`).toBeDefined()
    expect(resolve(value ?? '', 'light')).toBe(designLight.get(name))
    expect(resolve(value ?? '', 'dark')).toBe(designDark.get(name))
  })
})
