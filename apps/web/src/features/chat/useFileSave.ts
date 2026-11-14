import { useState } from "react";
import { capabilities } from "../../platform/capabilities.js";
import { saveFile, SaveUnsupportedError } from "../../platform/files.js";

export function useFileSave() {
  const [saveError, setSaveError] = useState<SaveUnsupportedError | null>(null);

  const handleSave = async (blob: Blob, filename: string): Promise<void> => {
    setSaveError(null);
    try {
      await saveFile(blob, filename);
    } catch (error) {
      if (error instanceof SaveUnsupportedError) {
        setSaveError(error);
        return;
      }
      throw error;
    }
  };

  return {
    capabilities,
    saveUnsupported: !capabilities.saveFile || saveError !== null,
    saveError,
    handleSave,
  };
}
