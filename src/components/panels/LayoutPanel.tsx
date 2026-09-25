/**
 * Which canvas layers (RGB composite views + mask) show up on screen for the
 * active scene, and in what left-to-right order. A scene may have anywhere
 * from 0 to 4+ RGB views (see SceneEntry.rgb_composites) -- this panel lets
 * the user hide the ones they don't need and reorder the rest, rather than
 * always showing every detected view.
 */

import { useSessionStore } from "@/state/sessionStore";
import { useLayoutStore, layerLabel, orderLayerKeys, rgbKeysForScene, MASK_KEY } from "@/state/layoutStore";

export default function LayoutPanel() {
  const activeScene = useSessionStore((s) => s.activeScene());

  // Select the raw visibility/order maps (not the store's isVisible/
  // toggleVisible/orderedKeys functions) so this panel actually re-renders
  // on every toggle/reorder -- a function pulled off a Zustand store never
  // changes identity, so selecting it never triggers a re-render when the
  // state it closes over changes; only selecting the state itself does.
  // This is why checking/unchecking or reordering here used to look like it
  // did nothing until some unrelated re-render (e.g. from painting) came
  // along and picked up the change as a side effect.
  const visibility = useLayoutStore((s) => s.visibility);
  const order = useLayoutStore((s) => s.order);
  const toggleVisible = useLayoutStore((s) => s.toggleVisible);
  const moveUp = useLayoutStore((s) => s.moveUp);
  const moveDown = useLayoutStore((s) => s.moveDown);

  const availableKeys = activeScene ? [...rgbKeysForScene(activeScene), MASK_KEY] : [];
  const keys = orderLayerKeys(availableKeys, order);
  const isVisible = (key: string) => visibility[key] ?? true;
  const visibleCount = keys.filter((k) => isVisible(k)).length;

  return (
    <section className="panel layout-panel" aria-label="Layout panel">
      <h3 className="panel__title">Layout</h3>
      <p className="panel__hint">
        Choose which views show up on screen and in what order. Canvas panels split the available
        width evenly across whatever is visible here.
      </p>

      {!activeScene && <p className="panel__hint">Load a scene to configure its layout.</p>}

      {activeScene && keys.length === 0 && (
        <p className="panel__hint">This scene has no RGB views or mask to display yet.</p>
      )}

      {activeScene && keys.length > 0 && (
        <ul className="layout-panel__list">
          {keys.map((key, i) => (
            <li key={key} className="layout-panel__row">
              <label className="panel__checkbox layout-panel__checkbox">
                <input
                  type="checkbox"
                  checked={isVisible(key)}
                  disabled={visibleCount <= 1 && isVisible(key)}
                  onChange={() => toggleVisible(key, availableKeys)}
                />
                {layerLabel(key)}
              </label>
              <div className="layout-panel__reorder">
                <button
                  type="button"
                  onClick={() => moveUp(key, availableKeys)}
                  disabled={i === 0}
                  title="Move earlier (further left)"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveDown(key, availableKeys)}
                  disabled={i === keys.length - 1}
                  title="Move later (further right)"
                >
                  ↓
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {activeScene && visibleCount === 0 && (
        <p className="panel__error">At least one view must stay visible.</p>
      )}
    </section>
  );
}
