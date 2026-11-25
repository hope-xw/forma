import { cloneDocument, type DesignDocument } from "../domain/document";
export interface History {
  present: DesignDocument;
  past: DesignDocument[];
  future: DesignDocument[];
}
export function commit(state: History, present: DesignDocument): History {
  return {
    present,
    past: [...state.past.slice(-99), state.present],
    future: [],
  };
}
export function travel(state: History, direction: "undo" | "redo"): History {
  const source = direction === "undo" ? state.past : state.future;
  const target = source.at(-1);
  if (!target) return state;
  const present = {
    ...cloneDocument(target),
    revision: state.present.revision + 1,
  };
  return direction === "undo"
    ? {
        present,
        past: source.slice(0, -1),
        future: [...state.future, state.present],
      }
    : {
        present,
        past: [...state.past, state.present],
        future: source.slice(0, -1),
      };
}
