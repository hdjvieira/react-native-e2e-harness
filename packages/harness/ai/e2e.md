# Testing the app on a device

The app's e2e folder (where `e2e.config.ts` is, often `e2e/`) holds everything that drives the app. Every command goes through the app's `e2e` script (`yarn e2e …`, or `npx e2e-harness …` in an app without one). Read the config first: the app ids, the starting screen (`home`), the dev link, the hooks. If the folder has its own notes (a README, a list of flows), read them before adding anything.

|             | Specs                                          | Ad-hoc checks                                                       |
| ----------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| What        | flow tests, kept and re-run (`specs/`)         | one command at a time, for a check not (yet) worth a spec           |
| Tool        | `yarn e2e run`                                 | `yarn e2e device …`, `ios-device …`, `slow-net …`                   |
| Device      | an emulator or simulator by default            | the connected device, often the developer's phone                   |
| Typical use | after a feature, before a bug fix, regressions | verifying a change by hand, timing a loader, exploring a flow first |

Both verify by **testID** in the UI tree, not by screenshots, which cost far more to read and say less. An ad-hoc check worth repeating should become a spec.

## Consent

- **Suggest, don't start.** Drive a device only when the developer asked for it or said yes to your suggestion, **for this task**: a yes for an earlier change does not carry over.
- Spec runs are then **fire and forget**: never stop mid-run to ask.
- **Wiping app data on the developer's own phone needs an explicit OK** (`device clear --yes` signs them out and resets their settings): ask once, saying how many wipes you need. An emulator is a test device: specs reset it as they need.
- **Never ask for a password or token in the chat.** Ask the developer to put it in the e2e folder's `.env.e2e` themselves; `.env.e2e.example` says what each key is.

## 1. Preflight

```bash
yarn e2e preflight
```

It fixes what it can and stops, with the reason, on what it can't:

- **secrets:** `.env.e2e` against `.env.e2e.example`; a missing `[required]` key stops the run.
- **device:** `E2E_ANDROID_DEVICE`, else a running emulator, else it boots `E2E_AVD`. iOS (`E2E_PLATFORM=ios`, macOS): `E2E_IOS_UDID`, else `E2E_SIMULATOR`, else the one iPhone on a cable, else a simulator with the app. **An iPhone Xcode sees but Appium can't reach (Wi-Fi only: since iOS 17 Appium needs the cable) stops the run** instead of falling back to a simulator: tell the developer and let them choose.
- **the app:** must be installed on that device. A debug build older than the last native change crashes on today's JS: rebuild it.
- **Appium and Metro:** started in a titled window of their own if they don't answer, and left running. **A Metro already up must serve this checkout**: a sibling checkout's Metro means the device runs other code while every check passes; the preflight stops on it.
- An emulator needs **at least 4 GB of RAM**: with 2 GB Android kills UiAutomator2 mid-run and every later test fails in 0 s ("instrumentation process is not running").

On iOS, the first session builds WebDriverAgent onto the device (about a minute). A phone needs `ios.teamId` (or `E2E_IOS_TEAM`) to sign it; nothing can be granted on a phone from the Mac.

## 2. Run specs

```bash
yarn e2e run                                   # every spec
yarn e2e run --spec specs/login.e2e.ts         # one spec
yarn e2e run --grep "#slow" --invert           # skip a tag (quoted: # starts a shell comment)
```

Run it in the background and wait to be told it ended. Every run: preflight → sweep → specs → sweep → summary, saved as `out/<run>/summary.md`. A failed test leaves a screenshot and the UI tree (`.png` / `.xml`) next to it: **read those before rerunning anything.**

- **App froze:** a request with no answer in 45 s gets the app killed from outside, the test fails as "app froze", and its retry starts fresh. Each freeze has its own section in the summary and is never just a flaky retry: report it as a possible app bug, with the step.
- **Release:** the summary starts with what was tested (the release the commit belongs to, the app build, branch, commit, uncommitted changes). Say which release when you report.
- **Old reports prune themselves** once their commit is released and nothing in them is still open. `yarn e2e reports` lists them.
- **A killed run skips its clean-ups:** run `yarn e2e sweep`. Stopping a background shell task does not stop WDIO's node processes: find them by command line (`wdio`, `local-runner`) and kill them first.
- **A spec that opens another app closes it afterwards** (the browser, a share target, Settings), or it is what Android shows when a later spec kills the app.

**Report:** the summary line, every failure with its cause (from the screenshot), every freeze, every clean-up that failed (never leave one silent). Tests under **Needs a person first** are a to-do for the developer (what to do on the device), not failures.

### The dashboard

Every run opens `http://localhost:4777` (or starts it in a window of its own): the live run with its ETA, past runs with their failures and screenshots, flaky tests, a module-by-device matrix; it also starts and queues runs. `yarn e2e dashboard` starts it by hand; `E2E_UI=off` keeps runs from opening it. When you start a run for the developer, tell them the page; when you report, the summary is the source of truth.

## 3. Ad-hoc checks

1. **Plan the cases first**, as a table: case, how to reach it, the testID that proves it. Each needs a known starting state; say which ones need a data wipe (Consent).
2. `yarn e2e device preflight`: one device (set `ANDROID_SERIAL` with several), a debug build, Metro serving **this** checkout, the port reversed. Fix every FAIL first.
3. Drive it one command at a time (`device help` lists them all):

| Command                                              | Use                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `ids`                                                | testIDs on screen now (notes dialogs, a red box, app not in front) |
| `wait <id> [ms]`, `gone <id> [ms]`                   | how long it took, and the epoch ms                                 |
| `watch <ms> <id…>`                                   | each id appearing and disappearing: short-lived states             |
| `tap <id>`, `tap <prefix>*`                          | the topmost visible match                                          |
| `tap <id> --watch <ms> <id…>`                        | tap, then watch in the same process (a loader)                     |
| `launch`, `restart`, `clear --yes`, `deeplink <url>` | starting states                                                    |
| `allow`                                              | accept Android permission dialogs                                  |
| `jslog [n] [regex]`                                  | the app's JS log, when the UI doesn't explain a result             |
| `shot <file.png>`                                    | last resort                                                        |

Every command first dismisses React Native's LogBox toasts, which take taps and aren't in the tree. Appium is the backend when it runs, adb otherwise.

4. **Report** as a table: case, expected, result (with the time where timing matters). Then what was not tested and why, what you changed temporarily and put back, and the state the device was left in.

**An iPhone:** `yarn e2e ios-device start` (unlocked, on a cable), then `tap`, `wait`, `has`, `text <id> [n]`, `link <url>`, `double-tap`, `two-finger-tap`, `drag` (`ios-device help`).

**A slow or dead network** (Android): `yarn e2e slow-net --hosts '<regex>' --delay <ms> --for <ms>` holds HTTPS connections to matching hosts (`--fail` refuses them). Run it in the background **with `--for`** and let it end by itself: that is what puts the device's proxy back. Stopped from outside, the device is left with no internet: run `slow-net --restore` at once, and check `adb shell settings get global http_proxy` prints `:0` before you finish. To time a loader: make the held request outlast the tap, `tap <button> --watch <ms> <loader-id> <next-id>`, and line its epochs up with the proxy's `opened at`.

## 4. Add a spec

After a feature, a flow or two for what was built. Before a bug fix, a spec that fails on the bug.

- `specs/<feature>/<flow>.e2e.ts`; one `describe` per starting state, one `it` per check. Start every test from a known screen: `restartApp()` (a JS reload when it can, a cold start otherwise), then a deep link (`openLink`) to where the test begins.
- Select by testID only: `tap`, `waitFor`, `waitGone`, `text`, `scrollTo`, `waitForAny` from `react-native-e2e-harness`. An element with no testID: add one to the app.
- After a tap that should open something, wait for that thing's own testID: a disabled button swallows the tap and nothing throws.
- **Tags** are `#words` in titles. The target tags decide where a test runs; tag only a test that truly needs it, and branch on `driver.isAndroid` otherwise:

  | tag                         | a run on…                                   |
  | --------------------------- | ------------------------------------------- |
  | `#android` / `#ios`         | the other platform leaves it out            |
  | `#on-android-emulator-only` | an Android phone leaves it out; iOS runs it |
  | `#on-android-device-only`   | an Android emulator leaves it out           |
  | `#on-ios-simulator-only`    | an iPhone leaves it out; Android runs it    |
  | `#on-ios-device-only`       | an iOS simulator leaves it out              |

  Contradicting tags (`#android #ios`, two device tags of one platform) stop the run before it starts.

- **A test that needs a person first** (an account signed in on the device) ends with `needsPerson(this, '<what to do>')` where it meets the gap: neither passed nor failed, never retried.
- **What the app never shows** (a state, a count, what a request sent) is read from a debug-only readout turned on by a flag on the dev link (`createE2ESwitches({ flags })` in the app), never from temporary log lines.
- **A write on a shared backend registers its clean-up before the write** (`registerCleanup`), and the clean-up checks the thing is gone. Extend the app's `sweep` hook to find that kind of leftover from a killed run.
- A new secret: add it to `.env.e2e.example` with `[required]` / `[optional]`, what it is for and where to get it, in the same change.
- Run the new spec until it passes, then once with the feature broken on purpose if that's cheap, so it is known to fail for the right reason. Typecheck the e2e folder before finishing.

## 5. Speed

Most of a run is setup, not checks. Make tests fast while they stay valid, and **judge every speed-up by the timing table** at the end of each summary (per step: how many, total, average; per platform). Wrap a new slow helper in `measure('label', …)`.

| scope      | what                                   | how                                                      |
| ---------- | -------------------------------------- | -------------------------------------------------------- |
| run        | preflight, sweep                       | the harness                                              |
| describe   | sign-in, shared test data              | `before`, cleaned in `after` (clean-up registered first) |
| test       | only the cheap reset to a known screen | `restartApp()` + a deep link, or a chain                 |
| test, cold | a check of the app's start itself      | `restartApp({ cold: true })`                             |

- A sign-in helper that ends on a fresh starting screen calls `markFresh()`: the next `restartApp()` skips itself.
- **Chain the steps of a flow:** `const flow = chain()`, then `flow(title, start, body)` instead of `it`. Each `start` has `check()` (a cheap position check, never what the test asserts) and `arrive()` (the full way there). A test carries on only if the one before passed and the check holds; a retry always arrives. Terminal or destructive steps last. `E2E_CHAIN_STOP=1` stops at the first failure and leaves the screen as it was.
- Share group data only with tests that don't change it. No fixed pauses where an element can be waited for.

## 6. Traps

- **Assert the screen's own root testID**, not the absence of others: screens below stay mounted, and stacked screens keep their ids in the tree.
- **The app's root testID missing from the tree means the app is not in front.** Never press Back or tap blindly then: the input lands on the launcher.
- Never measure through `.elementId`: a lookup that misses hands back an element with no id instead of throwing. `onScreen()` waits and measures.
- Android drops rows far outside the viewport from the tree and keeps rows just outside it with on-screen-looking bounds: `scrollTo(id, pageId)` handles both; never take "exists" for "visible". Pull a half-height sheet to full height before scrolling it (at half height a drag down moves the sheet, which snaps back, and a search never ends); inside a sheet or under a sticky header use `scrollTo(id, page, { below: headerId, slow: true })`. Checking many rows: `collectIds(endId)` reads them all in one pass, a `scrollTo` per row can blow the test timeout.
- iOS: an id inside an accessible container (a `Pressable`) doesn't exist for XCUITest; the first tap on something just opened goes through `tapUntil(button, whatItOpens)`; taps on a sheet still sliding in need `tap(id, { settle: true })`; a row that is one accessibility element is found by its label (`rowContaining`); never enumerate every element on a large screen (it hangs).
- **After Fast Refresh a new screen can do nothing** (no error): restart the app before concluding anything. Start-up code needs a restart anyway.
- A swipe that starts near a screen edge is a system gesture on a phone with gesture navigation (Back, Home): start swipes well inside the screen, and check `ids` afterwards.
- A red box shows in `ids` as `NOTE RED BOX: <title>`; `jslog` has the JS side.
- Two devices attached: every ad-hoc command needs `ANDROID_SERIAL`, and nothing should stay attached to the developer's phone when you are done (`device end`).
- Temporary code changes for a test are put back with an editor, not `sed -i`: on Windows it rewrites line endings. Check `git diff --stat` after.
