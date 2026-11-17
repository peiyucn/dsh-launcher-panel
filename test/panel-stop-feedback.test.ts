import { test } from 'node:test'
import assert from 'node:assert/strict'
import { panelScript } from '../src/panel/webview/panel-script.ts'

const script = panelScript({ peakWindows: '[]', defaultBrowser: 'built-in' })

test('clicking Stop acknowledges the click before the host replies', () => {
  assert.match(script, /el\.statusText\.textContent = 'Stopping…'/u, 'the status line must report Stopping… on click')
  assert.match(script, /b\.textContent = 'Stopping…'/u, 'the Stop button must relabel itself on click')
  assert.match(script, /b\.disabled = true[\s\S]{0,400}vscode\.postMessage/u, 'the clicked button must be disabled before the message is posted')
})

test('the next status update owns the Stop button state again', () => {
  assert.match(script, /el\.stopBtn\.disabled = stopping/u, 'a stopping status must keep the button disabled')
  assert.match(script, /el\.stopBtn\.textContent = stopping \? 'Stopping…' : '■ Stop'/u, 'any settled update must restore the label')
})

test('Edit and Delete are disabled together, except for detected instances', () => {
  assert.match(
    script,
    /el\.editInstanceBtn\.disabled = !active \|\| locked[\s\S]{0,120}el\.deleteInstanceBtn\.disabled = !active \|\| locked/u,
    'both actions must share the running-instance lock',
  )
})
