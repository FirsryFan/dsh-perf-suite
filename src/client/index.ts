/**
 * @dsh-external/dsh-perf-suite — client half.
 *
 * Merged from:
 * - dsh-chat-content-visibility-auto: inject content-visibility CSS.
 * - dsh-webui-perf: WebUI performance switch + settings row.
 * - dsh-perf-suite: unified status.
 */
import * as React from 'react'

export const name = '@dsh-external/dsh-perf-suite'
export const inject = ['slots', 'settingsScope', 'locale']

const NS = 'webui-perf'
const STORAGE_KEY = 'dsh.webui-perf.enabled'
const CHANGE_EVENT = 'dsh:webui-perf-change'
const STYLE_ID = 'dsh-perf-suite-content-visibility-css'

function isEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

function publish(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(enabled))
  } catch {
    // ignore private-mode failures
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { enabled } }))
}

function injectContentVisibility(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '[data-chat-flow] > [data-chat-anchor-key] {',
    '  content-visibility: auto;',
    '  contain-intrinsic-size: auto 320px;',
    '}',
  ].join('\n')
  ;(document.head ?? document.documentElement).appendChild(style)
}

const zh = {
  'perf.title': '性能优化套件',
  'perf.description': 'WebUI 渲染/高亮缓存优化、聊天列表 content-visibility、Context Pool 按需展开',
  'perf.on': '已开启',
  'perf.off': '已关闭',
}
const en = {
  'perf.title': 'Performance Suite',
  'perf.description': 'WebUI render/highlight cache, chat content-visibility, Context Pool on-demand expansion',
  'perf.on': 'On',
  'perf.off': 'Off',
}

function PerfRow(props: { t: (key: string) => string; enabled: boolean; setEnabled(value: boolean): void }): React.ReactElement {
  const { t, enabled, setEnabled } = props
  return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' } },
    React.createElement('span', { style: { flex: 1 } }, t('perf.title')),
    React.createElement('span', { style: { fontSize: 12, color: '#888' } }, enabled ? t('perf.on') : t('perf.off')),
    React.createElement('button', {
      type: 'button',
      onClick: () => setEnabled(!enabled),
      style: { minWidth: 72 },
    }, enabled ? t('perf.on') : t('perf.off')),
  )
}

type ClientContext = {
  slots: any
  settingsScope: any
  locale: any
  effect(fn: () => () => void, label?: string): void
}

export function apply(ctx: ClientContext): void {
  injectContentVisibility()
  publish(isEnabled())

  ctx.effect(() => {
    return () => {
      const style = document.getElementById(STYLE_ID)
      style?.remove()
    }
  }, '@dsh-external/dsh-perf-suite: remove stylesheet')

  // Locale + settings row (ported from dsh-webui-perf).
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), '@dsh-external/dsh-perf-suite: locale')

  const scope = ctx.settingsScope.bind({ namespace: NS })
  const onScopeChange = (): void => {
    const snap = scope.getSnapshot()
    const value = snap?.value
    publish(value === undefined ? true : value.enabled !== false)
  }
  scope.subscribe?.(onScopeChange)
  onScopeChange()

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'dsh-perf-suite',
    order: 5,
    locale: NS,
    inject: () => ({
      hooks: { perf: scope },
      setEnabled(value: boolean): void {
        scope.set('enabled', !!value)
      },
    }),
  }, PerfRow))
}
