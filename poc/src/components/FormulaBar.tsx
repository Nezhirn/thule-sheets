import { ChevronDown, FunctionSquare } from 'lucide-react';

interface FormulaBarProps {
  address: string;
  formula: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

export function FormulaBar({ address, formula, onChange, onCommit, onCancel }: FormulaBarProps) {
  return (
    <div className="formula-bar">
      <button className="formula-address" title="Имя диапазона">
        {address}
        <ChevronDown size={12} />
      </button>
      <span className="formula-fx">
        <FunctionSquare size={14} />
      </span>
      <input
        className="formula-input"
        value={formula}
        spellCheck={false}
        placeholder="Введите значение или формулу"
        aria-label="Строка формул"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
    </div>
  );
}
