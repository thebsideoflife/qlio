import { useState, useRef, useEffect } from "react";
import { Pencil } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface EditableTitleProps {
  title: string;
  onSave: (newTitle: string) => void;
  className?: string;
  inputClassName?: string;
  showEditIcon?: boolean;
}

export function EditableTitle({
  title,
  onSave,
  className,
  inputClassName,
  showEditIcon = false,
}: EditableTitleProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(title);
  }, [title]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const save = () => {
    const trimmed = value.trim();
    setIsEditing(false);
    if (!trimmed || trimmed === title) {
      setValue(title);
      return;
    }
    // Optimistic update - caller handles persistence (Redux dispatch or API call)
    setValue(trimmed);
    onSave(trimmed);
  };

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setValue(title);
            setIsEditing(false);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        className={cn("h-8 text-sm", inputClassName)}
      />
    );
  }

  return (
    <span
      className={cn(
        "cursor-pointer truncate group/title inline-flex items-center gap-1",
        className
      )}
      onClick={(e) => {
        e.stopPropagation();
        setIsEditing(true);
      }}
    >
      <span className="truncate">{title || "Untitled"}</span>
      {showEditIcon && (
        <Pencil className="h-3 w-3 shrink-0 opacity-0 group-hover/title:opacity-100 transition-opacity text-muted-foreground" />
      )}
    </span>
  );
}
