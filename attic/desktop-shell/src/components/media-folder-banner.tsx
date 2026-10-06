import { useState } from "react"

/** Displays the poster belonging to the directory currently open in the file browser. */
export function MediaFolderBanner({ imageUrl, title }: { imageUrl: string; title: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <div className="media-folder-banner">
      <img src={imageUrl} alt="" onError={() => setFailed(true)} />
      <span className="media-folder-banner-name">{title}</span>
    </div>
  )
}
