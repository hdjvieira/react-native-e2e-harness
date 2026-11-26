// "Needs a person first": a test that can't run until someone does something
// by hand on the device (sign in to a store account, log in to a social
// network in the browser). It neither passes nor fails: it ends as a skip
// with what to do, which the summary lists under its own heading. Never
// retried, since a retry can't do it either.
//
// Detect it where the test meets it, not up front: the test taps the button
// and looks at what opened (an account to pick, or a sign-in form), so it
// works the same on any device.

const reasons = new Map<string, string>()

/** ends this test as "needs a person first", saying what they have to do */
export function needsPerson(context: Mocha.Context, what: string): never {
  const test = context.currentTest ?? context.test
  if (test) reasons.set(`${test.parent?.title} > ${test.title}`, what)
  context.skip()
  throw new Error('unreachable: skip() throws')
}

/** what the test asked for, once, for its result line */
export function takeNeedsPerson(title: string) {
  const what = reasons.get(title)
  reasons.delete(title)
  return what
}
