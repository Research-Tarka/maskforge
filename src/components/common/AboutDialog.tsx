/** Legal notice dialog: copyright, license, and source link (required by AGPLv3 section 5d). */

import Dialog from "./Dialog";

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

const APP_VERSION = "0.1.0";
const SOURCE_URL = "https://github.com/Research-Tarka/maskforge";

export default function AboutDialog({ open, onClose }: AboutDialogProps) {
  return (
    <Dialog open={open} title="About MaskForge" onClose={onClose} width={480}>
      <p>
        <strong>MaskForge</strong> v{APP_VERSION}
        <br />
        Copyright (C) {new Date().getFullYear()} Maxime Tarka
      </p>
      <p>
        This program is free software: you can redistribute it and/or modify it under the terms of
        the GNU Affero General Public License as published by the Free Software Foundation, either
        version 3 of the License, or (at your option) any later version.
      </p>
      <p>
        This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
        without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
      </p>
      <p>
        Source code:{" "}
        <a href={SOURCE_URL} target="_blank" rel="noreferrer">
          {SOURCE_URL}
        </a>
      </p>
    </Dialog>
  );
}
