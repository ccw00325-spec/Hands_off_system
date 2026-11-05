# Hands off System maintenance

The owner requested that every update be maintained and pushed to both public repositories:

- Windows: https://github.com/ccw00325-spec/Hands_off_system_Window (remote `origin`)
- macOS: https://github.com/ccw00325-spec/Hands_off_system_Mac (remote `mac`)

Keep one shared source history and version. Implement and verify changes here, commit selected project files, then run `npm run sync:platforms` to push that commit to both repositories. Do not force-push or overwrite divergent remote work. If either push or platform verification fails, fix it or report that exact outstanding limitation; never say both platforms were verified because Windows passed. Check each remote HEAD before reporting completion.

Windows builds run on Windows. macOS Intel and Apple Silicon builds and native startup tests run on the corresponding macOS GitHub Actions runners. Maintain both build paths, licensing notices, and README links. Do not claim notarization or Developer ID signing without actual verification.

Preserve user data paths, OS-user credential isolation, folder grants, and explicit execution permissions. A selected Docker backend must never silently fall back to host execution. Do not package `.runtime`, credential stores, test profiles, `.git`, or unrelated `Skill_Mutation_Testing/` work.

Increment the patch version once per completed update via `npm run version:next`, rolling .9 to the next minor. Rebuilds keep that version. Remove old Windows executables only after the new package passes verification. Keep generated validation evidence outside source commits.

The repository owner authorized these maintenance changes. External commercial use, derivative work and model training still follow LICENSE; do not relicense third-party materials.
