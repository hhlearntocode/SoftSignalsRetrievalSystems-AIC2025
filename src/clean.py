import os
from pathlib import Path


def delete_png_files(directory: str):
    """
    Delete all .png files inside the given directory (non-recursive).

    Args:
        directory (str): Path to the directory.
    """
    dir_path = Path(directory)
    if not dir_path.exists() or not dir_path.is_dir():
        print(f"Error: {directory} is not a valid directory")
        return

    count = 0
    for file in dir_path.glob("*.png"):
        try:
            file.unlink()
            count += 1
        except Exception as e:
            print(f"Failed to delete {file}: {e}")

    print(f"Deleted {count} PNG file(s) from {directory}")


for scene in Path("scenes").iterdir():
    if scene.is_dir():
        delete_png_files(str(scene))
