import { useBoardStore } from '../../hooks/useBoardStore';

export function SelectedNameLabel() {
  const { selectedPart, selectedPin, selection } = useBoardStore();
  const highlightedNet = selection.highlightedNet;

  let text: string | null = null;
  if (selectedPin && selectedPart) {
    text = `${selectedPart.name} · pin ${selectedPin.name} → ${selectedPin.net || '(unconnected)'}`;
  } else if (selectedPart) {
    text = selectedPart.name;
  } else if (highlightedNet) {
    text = highlightedNet;
  }

  if (!text) return null;
  return <div className="overlay-selected-name" data-testid="overlay-selected-name">{text}</div>;
}
