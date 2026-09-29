// A resolver-capable ROOT frame carrying the same self-hosted `BASE_ROSTER` vocabulary every
// bare `exec()` shares (env/vocabulary.ts's memoized `buildVocabulary`). The live inheritable
// base: internal callers mint `inferenceEnv.child(name)`, bind test-only rosettas onto it,
// and evaluate through `execStateOverFrame`/`execOverFrame`/`execExprOverFrame`
// (eval/generator-exec.ts's internal, non-`ExecOptions` live-frame seam for a caller that already
// holds a real frame rather than a declarative capability set). NOT barrel-exported.
//
// POPULATION IS LAZY: `inferenceEnv.child(…)` at test setup is always safe (a frame mint is
// a cheap `__parent__` assignment, not a snapshot read) because nothing walks the parent chain
// until an actual eval call, and every eval entry point that might touch this frame awaits
// `ensureInferenceEnvPopulated` first (generator-exec.ts's `*OverFrame` family).
import { ResolvingAmbient } from "./AmbientRuntime.js";

export const inferenceEnv: ResolvingAmbient = ResolvingAmbient.root("inference");
