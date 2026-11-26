import assert from 'node:assert/strict'
import { it } from 'node:test'
import { findDevOverlays, parseAllNodes, parseSource } from './source.js'

const xml = `<hierarchy>
<android.widget.FrameLayout bounds="[0,0][1080,2400]">
<android.view.ViewGroup resource-id="com.example.app:id/home-screen" bounds="[0,0][1080,2400]" />
<android.widget.TextView text='Make sure "Metro" runs' resource-id="com.example.app:id/hint" bounds="[0,100][500,150]" />
<android.widget.Button resource-id="com.android.permissioncontroller:id/permission_allow_button" clickable="true" bounds="[100,1000][900,1100]" />
<android.view.ViewGroup content-desc="12, [ERROR] something" bounds="[0,2200][1080,2300]" />
<android.view.ViewGroup content-desc="1, Following" resource-id="com.example.app:id/following-button" bounds="[0,2300][300,2400]" />
</android.widget.FrameLayout>
</hierarchy>`

it("parses both quote styles and strips only the app's own id prefix", () => {
  const nodes = parseSource(xml, 'com.example.app')
  assert.deepEqual(
    nodes.map(n => n.testID),
    [
      'home-screen',
      'hint',
      'com.android.permissioncontroller:id/permission_allow_button',
      'following-button',
    ],
  )
  assert.equal(nodes[1].text, 'Make sure "Metro" runs')
  assert.deepEqual(nodes[1].bounds, { x: 0, y: 100, w: 500, h: 50 })
})

it('finds a LogBox toast, never an app button that reads like one', () => {
  const { boxes } = findDevOverlays(parseAllNodes(xml, 'com.example.app'))
  assert.deepEqual(
    boxes.map(b => b.desc),
    ['12, [ERROR] something'],
  )
})
