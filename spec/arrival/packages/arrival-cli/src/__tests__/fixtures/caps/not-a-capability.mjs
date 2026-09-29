// Fixture NON-capability module — exports exist, none is an EnvCapability. `--with`
// on this module must produce the teaching error naming what WAS found.
export const helper = 42;
export default function nothingToArm() {
  return "not a capability";
}
