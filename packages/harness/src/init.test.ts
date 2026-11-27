import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, it } from 'node:test'
import { describeInit, detectApp, init, packageManager } from './init.js'

const app = mkdtempSync(join(tmpdir(), 'harness-init-'))
after(() => rmSync(app, { recursive: true, force: true }))

writeFileSync(
  join(app, 'package.json'),
  '{\n  "name": "my-app",\n  "scripts": { "start": "react-native start" }\n}\n',
)
writeFileSync(join(app, 'yarn.lock'), '')
writeFileSync(
  join(app, 'tsconfig.json'),
  '{ "extends": "@react-native/typescript-config" }',
)
mkdirSync(join(app, 'android', 'app'), { recursive: true })
writeFileSync(
  join(app, 'android/app/build.gradle'),
  'android {\n    namespace "com.myapp"\n    defaultConfig {\n        applicationId "com.myapp.debug"\n    }\n}\n',
)
mkdirSync(join(app, 'ios', 'MyApp.xcodeproj'), { recursive: true })
writeFileSync(
  join(app, 'ios/MyApp.xcodeproj/project.pbxproj'),
  'PRODUCT_BUNDLE_IDENTIFIER = "org.example.MyAppTests";\nPRODUCT_BUNDLE_IDENTIFIER = com.myapp;\n',
)

it("reads the app's ids from its native projects", () => {
  assert.deepEqual(detectApp(app), {
    androidPackage: 'com.myapp.debug',
    androidNamespace: 'com.myapp',
    iosBundleId: 'com.myapp',
    iosExecutable: 'MyApp',
  })
  assert.equal(packageManager(app), 'yarn')
})

it('creates the e2e folder and the package.json entries, and keeps what is there', () => {
  const first = init({}, join(app, 'android'))
  assert.ok(first.created.includes('e2e/e2e.config.ts'))
  assert.match(
    readFileSync(join(app, 'e2e/e2e.config.ts'), 'utf8'),
    /package: 'com\.myapp\.debug', namespace: 'com\.myapp'/,
  )
  const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts.e2e, 'e2e-harness')
  assert.equal(manifest.scripts.start, 'react-native start')
  assert.deepEqual(manifest['e2e-harness'], { config: 'e2e/e2e.config.ts' })
  assert.ok(
    first.notes.some(n =>
      n.includes("leave e2e/ out of the app's tsconfig.json"),
    ),
  )
  assert.match(describeInit(first), /yarn e2e preflight/)

  const again = init({}, app)
  assert.equal(again.created.length, 0)
  assert.equal(again.packageJson.length, 0)
  assert.ok(existsSync(join(app, 'e2e/support/README.md')))
})
