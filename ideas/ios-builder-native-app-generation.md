# Generate native iOS apps with MobAI iOS Builder

## Summary

Add an OMG execution path that generates a native iOS app instead of a browser
app, using [MobAI-App/ios-builder](https://github.com/MobAI-App/ios-builder) for
remote macOS builds and IPA artifacts. MobAI simulator/device sharing is
explicitly out of scope because OMG must not require a `MOBAI_API_KEY`. The
existing `OpenCode` and `Goal` label semantics remain the
entry point; this idea changes the project target selected by an explicit iOS
platform label or request requirement.

## Motivation

OMG currently optimizes for a web runtime and validates the result through a
browser and public tunnel. iOS projects need Xcode-compatible source, a macOS
GitHub Actions build, an IPA artifact, and (when available) a simulator or
device session. MobAI Builder supplies a supported CLI and generated
`ios-build.yml`, avoiding a bespoke macOS runner implementation; OMG will use
only its GitHub Actions build capabilities.

## Proposed flow

1. Add a synchronized `platform/ios` issue label. An issue labeled `OpenCode`
   and `platform/ios` selects the native-app prompt and iOS delivery path.
2. Ask OpenCode to create a native Swift/SwiftUI app by default, while allowing
   the prompt to request Flutter, React Native, Kotlin Multiplatform, or another
   Builder-detected framework.
3. Install or invoke `builder init` in the generated project to create the
   repository's `ios-build.yml` workflow. Keep the generated workflow in the
   project and review it as part of the pull request.
4. Run `builder ios build` from the OMG worker, capture the resulting IPA and
   GitHub Actions run URL, and publish the artifact as a workflow output or
   release asset.
5. Validate the generated source, build logs, and IPA metadata. Do not invoke
   `builder ios share` or any MobAI device integration from the OMG workflow.
6. Ask OpenCode for a final implementation report that links the source PR,
   iOS build run, IPA artifact, and signing status.

## Configuration and secrets

- The generated repository needs GitHub Actions permissions to run on a
  `macos-*` runner with a supported Xcode version; iOS builds cannot run on the
  existing Linux worker.
- Builder must be able to trigger and read the nested GitHub Actions build with
  an appropriate GitHub token. Keep this authentication separate from Apple
  signing credentials and do not expose either in issue text or logs.
- Unsigned builds should be the default so contributors can validate the
  project without Apple credentials.
- Signed builds require Apple Developer membership and Builder's signing
  secrets; never place certificates or provisioning profiles in issue text or
  logs. OMG must not add, read, or configure `MOBAI_API_KEY`.
- The local Builder configuration may use `builder.json` for project path and
  scheme, but must not include MobAI device integration settings.

## Non-default integration work

- Generate a valid Xcode project, scheme, bundle identifier, deployment target,
  and source layout before invoking Builder. Swift/SwiftUI is the default;
  Flutter, React Native, and Kotlin Multiplatform need framework-specific
  dependency-install and build commands.
- Run `builder init` in the generated project and review the resulting
  `ios-build.yml`; Builder setup is not a substitute for validating the app's
  project structure.
- Replace the web workflow's `npm run start`, browser/public-URL checks, and
  web screenshots with iOS checks: dependency resolution, Xcode compilation,
  IPA existence and non-empty size, archive metadata, and the nested build URL.
- Add longer macOS/Xcode timeouts and cache Swift Package Manager, CocoaPods,
  Gradle, or npm dependencies where the selected framework needs them.
- Handle artifact handoff explicitly: locate the IPA produced by Builder,
  verify it, and link or attach it from the OMG issue/release. A successful
  nested workflow alone is not sufficient evidence if the artifact is missing.
- Keep signing opt-in. Unsigned builds are the default acceptance path; signed
  builds need a separate secret configuration and must report their signing
  status without claiming device installation.

## Prompt and workflow changes

- Add an iOS-specific build prompt and verification prompt under
  `.github/prompts/`, keeping the existing web prompts unchanged.
- Replace browser/public-tunnel checks with framework-aware checks: project
  structure, generated Xcode/Builder workflow, `builder ios build` success,
  artifact existence, and a reproducible build URL.
- Keep the existing `Goal` label behavior: goal mode is selected by the issue
  label, never by a `/goal` command.
- Add explicit delivery metadata so the final issue comment distinguishes
  unsigned versus signed IPAs and clearly reports build-only verification.

## Acceptance criteria

- An `OpenCode` issue labeled `platform/ios` produces a buildable iOS project and a
  reviewed `ios-build.yml` workflow.
- `builder ios build` completes on GitHub Actions macOS and yields a non-empty
  IPA artifact, with the run and artifact linked from the issue report.
- The OMG worker handles Builder/GitHub authentication, nested-run polling,
  artifact transfer, and macOS/Xcode timeouts without exposing credentials.
- Goal-mode issues use the same persistent Goal orchestration as other OMG
  requests; standard web issues remain unchanged.
- Missing Apple signing credentials produce a clear unsigned/build-only result,
  not a false claim that the app was installed or tested on a device.
- The workflow never requires or consumes `MOBAI_API_KEY` and never claims
  simulator/device verification.

## Open questions

- Should `platform/ios` be exclusive, or should one issue generate both web and
  iOS deliverables when both labels are present?
- Should the IPA be attached to the OMG release, the nested iOS workflow run,
  or both?
- Should a future credential-free simulator integration be considered, or should
  iOS delivery remain intentionally build-only?

## Reference

- [MobAI iOS Builder](https://github.com/MobAI-App/ios-builder)
- [Builder README](https://raw.githubusercontent.com/MobAI-App/ios-builder/main/README.md)
