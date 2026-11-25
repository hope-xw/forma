import { useState } from "react";
import { AssetPreview } from "./AssetPreview";
import { displayColor, type ColorProfile } from "../domain/color-profile";
import { propertyLabels } from "../domain/design-properties";
import {
  sameDefinition,
  type ReviewDefinition,
} from "../domain/library-review";
import type { ComponentLibrary } from "../domain/library-schema";
import type { DesignSystem } from "../domain/design-system-schema";

function columns(def: ReviewDefinition, system?: DesignSystem) {
  const values = new Map<string, { label: string; text: string }>();
  const put = (id: string, label: string, value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => put(id + "/" + i, label + " " + (i + 1), v));
      return;
    }
    if (value && typeof value === "object") {
      if ("alias" in value) {
        const variable = String(value.alias);
        put(id, label, system?.variables[variable]?.name ?? variable);
      } else
        for (const [k, v] of Object.entries(value))
          put(id + "/" + k, label + " · " + (propertyLabels[k] ?? k), v);
      return;
    }
    values.set(id, {
      label,
      text:
        value === true ? "是" : value === false ? "否" : String(value ?? "—"),
    });
  };
  put("name", "名称", def.name);
  if ("values" in def) {
    const collection = system?.collections[def.collectionId];
    put("type", "变量类型", def.type);
    for (const [id, value] of Object.entries(def.values))
      put(
        "value/" + id,
        collection?.modes.find((m) => m.id === id)?.name ?? id,
        value,
      );
    put("description", "说明", def.description);
    put("code", "代码名称", def.codeSyntax);
    put(
      "scopes",
      "适用属性",
      def.scopes.map((k) => propertyLabels[k] ?? k),
    );
  } else if ("properties" in def) {
    for (const [id, v] of Object.entries(def.properties))
      put(id, propertyLabels[id] ?? id, v);
    for (const [id, v] of Object.entries(def.bindings))
      put(
        "binding/" + id,
        (propertyLabels[id] ?? id) + "变量",
        system?.variables[v]?.name ?? v,
      );
    put("description", "说明", def.description);
  } else {
    for (const m of def.modes) put("mode/" + m.id, "模式", m.name);
    put(
      "default",
      "默认模式",
      def.modes.find((m) => m.id === def.defaultModeId)?.name,
    );
  }
  return values;
}
function Value({
  text,
  colorProfile,
}: {
  text?: string;
  colorProfile?: ColorProfile;
}) {
  return (
    <td>
      {text && /^#[a-f\d]{6,8}$/i.test(text) && (
        <i
          aria-hidden="true"
          className="review-swatch"
          style={{ backgroundColor: displayColor(text, colorProfile) }}
        />
      )}
      {text ?? "—"}
    </td>
  );
}
export function DefinitionDiff({
  local,
  remote,
  localSystem,
  remoteSystem,
  colorProfile,
}: {
  local: ReviewDefinition;
  remote: ReviewDefinition;
  localSystem?: DesignSystem;
  remoteSystem?: DesignSystem;
  colorProfile?: ColorProfile;
}) {
  const a = columns(local, localSystem),
    b = columns(remote, remoteSystem);
  return (
    <table className="definition-diff" aria-label="比较定义">
      <thead>
        <tr>
          <th>属性</th>
          <th>本地</th>
          <th>库版本</th>
        </tr>
      </thead>
      <tbody>
        {[...new Set([...a.keys(), ...b.keys()])]
          .filter((k) => a.get(k)?.text !== b.get(k)?.text)
          .map((k) => (
            <tr key={k}>
              <th>{(b.get(k) ?? a.get(k))!.label}</th>
              <Value text={a.get(k)?.text} colorProfile={colorProfile} />
              <Value text={b.get(k)?.text} colorProfile={colorProfile} />
            </tr>
          ))}
      </tbody>
    </table>
  );
}

export function RevisionPreview({
  previous,
  incoming,
  id,
}: {
  previous: ComponentLibrary;
  incoming: ComponentLibrary;
  id: string;
}) {
  const [open, setOpen] = useState(false),
    [choice, setChoice] = useState("");
  const old = previous.components.find((c) => c.id === id),
    next = incoming.components.find((c) => c.id === id);
  const variants = [
    ...new Set([
      ...(next?.variants.map((v) => v.id) ?? []),
      ...(old?.variants.map((v) => v.id) ?? []),
    ]),
  ];
  const changed = variants.filter(
    (v) =>
      !sameDefinition(
        old?.variants.find((s) => s.id === v),
        next?.variants.find((s) => s.id === v),
      ),
  );
  const shown = choice || changed[0] || variants[0];
  const name = (next ?? old)!.name;
  return (
    <details
      className="review-visual"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary aria-label={"比较组件 " + name}>
        比较外观{changed.length > 1 ? " · " + changed.length + " 个变体" : ""}
      </summary>
      {open && (
        <>
          {variants.length > 1 && (
            <select
              aria-label={"比较变体 " + name}
              value={shown}
              onChange={(ev) => setChoice(ev.target.value)}
            >
              {variants.map((id) => (
                <option key={id} value={id}>
                  {
                    (next?.variants.find((v) => v.id === id) ??
                      old!.variants.find((v) => v.id === id))!.name
                  }
                </option>
              ))}
            </select>
          )}
          <div className="review-pair">
            {[previous, incoming].map((lib, i) => {
              const variant = lib.components
                .find((c) => c.id === id)
                ?.variants.find((v) => v.id === shown);
              const root = variant?.nodes.find((n) => !n.parentId);
              return (
                <figure key={i}>
                  <figcaption>
                    {i ? "新修订" : "已安装"} · r{lib.revision}
                  </figcaption>
                  {variant && root ? (
                    <>
                      <AssetPreview
                        variant={variant}
                        images={lib.images}
                        designSystem={lib.designSystem}
                      />
                      <small>
                        {root.style.width} × {root.style.height} px ·{" "}
                        {variant.nodes.length} 层
                      </small>
                    </>
                  ) : (
                    <small>{i ? "此版本已移除" : "此版本未提供"}</small>
                  )}
                </figure>
              );
            })}
          </div>
        </>
      )}
    </details>
  );
}
