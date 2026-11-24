// Stand-in scene for a chapter that has no scene module yet: the beat's on-screen words and its
// code excerpt, nothing else. It keeps the film renderable end to end while scenes are drawn.

export default {
  strings: {},
  setup(stage, kit, T) {
    const words = kit.text(stage, { x: 160, y: 300, w: 1600, size: 84, weight: 600, font: 'display', lh: 1.12 });
    const panels = Object.fromEntries(
      T.chapter.beats
        .filter(id => T.beat(id).code)
        .map(id => [id, kit.code(stage, T.beat(id).code, { x: 160, y: 520, w: 1500 })]),
    );
    return { words, panels };
  },
  frame({ words, panels }, T) {
    const id = T.active();
    words.set(T.str(id)).op(T.p(id, 0, 0.5));
    Object.entries(panels).forEach(([beatId, panel]) =>
      panel.update({ op: beatId === id ? T.p(id, 0.2, 0.6) : 0, reveal: T.p(beatId, 0.3, 1.4, 'linear') }),
    );
  },
};
