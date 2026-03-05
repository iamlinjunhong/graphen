import { useState } from "react";
import type { FactValueType } from "@graphen/shared";

interface InlineFactFormProps {
  subjectNodeId: string;
  subjectLabel: string;
  onSave: (data: {
    subjectNodeId: string;
    predicate: string;
    objectText: string;
    valueType: FactValueType;
  }) => void;
  onCancel: () => void;
}

export function InlineFactForm({ subjectNodeId, subjectLabel, onSave, onCancel }: InlineFactFormProps) {
  const [predicate, setPredicate] = useState("");
  const [objectText, setObjectText] = useState("");
  const [valueType, setValueType] = useState<FactValueType>("text");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!predicate.trim() || !objectText.trim()) return;
    onSave({ subjectNodeId, predicate: predicate.trim(), objectText: objectText.trim(), valueType });
  }

  return (
    <form className="memory-inline-form" onSubmit={handleSubmit}>
      <div className="memory-inline-form-row">
        <label>主语</label>
        <input type="text" value={subjectLabel} disabled />
      </div>
      <div className="memory-inline-form-row">
        <label>谓语</label>
        <input
          type="text"
          value={predicate}
          onChange={(e) => setPredicate(e.target.value)}
          placeholder="例如：职位、部门"
          autoFocus
        />
      </div>
      <div className="memory-inline-form-row">
        <label>宾语</label>
        <input
          type="text"
          value={objectText}
          onChange={(e) => setObjectText(e.target.value)}
          placeholder="例如：CTO、技术部"
        />
        <select value={valueType} onChange={(e) => setValueType(e.target.value as FactValueType)}>
          <option value="text">text</option>
          <option value="entity">entity</option>
          <option value="number">number</option>
          <option value="date">date</option>
        </select>
      </div>
      <div className="memory-inline-form-actions">
        <button type="button" className="docs-action-button" onClick={onCancel}>取消</button>
        <button type="submit" className="docs-action-button" disabled={!predicate.trim() || !objectText.trim()}>保存</button>
      </div>
    </form>
  );
}
