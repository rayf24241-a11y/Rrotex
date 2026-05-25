import json
import os
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox


APP_URL = "https://www.rrotex.com"
STATE_PATH = Path(os.environ.get("APPDATA", str(Path.home()))) / "ROTEX" / "pc_state.json"


class RotexPcApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("ROTEX PC")
        self.geometry("820x560")
        self.minsize(720, 500)
        self.configure(bg="#06070b")
        self.state_data = self.load_state()
        self.build_ui()
        self.render()

    def load_state(self):
        if STATE_PATH.exists():
            try:
                return json.loads(STATE_PATH.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass
        return {"connected": False, "code": "", "folder": "", "email": ""}

    def save_state(self):
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(self.state_data, indent=2), encoding="utf-8")

    def build_ui(self):
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        header = tk.Frame(self, bg="#0d1118", padx=22, pady=18)
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(1, weight=1)

        mark = tk.Label(header, text="R", bg="#4cc9f0", fg="#06070b", width=3, height=1, font=("Segoe UI", 18, "bold"))
        mark.grid(row=0, column=0, rowspan=2, padx=(0, 12))
        tk.Label(header, text="ROTEX PC", bg="#0d1118", fg="#f5f8fc", font=("Segoe UI", 20, "bold")).grid(row=0, column=1, sticky="w")
        self.status_label = tk.Label(header, text="", bg="#0d1118", fg="#80ed99", font=("Segoe UI", 10, "bold"))
        self.status_label.grid(row=1, column=1, sticky="w")
        tk.Button(header, text="Log in on ROTEX", command=lambda: webbrowser.open(APP_URL), bg="#ffd166", fg="#06070b", relief="flat", padx=14, pady=8, font=("Segoe UI", 10, "bold")).grid(row=0, column=2, rowspan=2)

        body = tk.Frame(self, bg="#06070b", padx=28, pady=26)
        body.grid(row=1, column=0, sticky="nsew")
        body.columnconfigure(0, weight=1)
        body.columnconfigure(1, weight=1)

        left = tk.Frame(body, bg="#131a24", padx=20, pady=20)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 10))
        tk.Label(left, text="Pair with phone", bg="#131a24", fg="#f5f8fc", font=("Segoe UI", 24, "bold")).pack(anchor="w")
        tk.Label(left, text="Open ROTEX on your phone, make a 3 digit code, then enter it here.", bg="#131a24", fg="#9cadc1", wraplength=320, justify="left").pack(anchor="w", pady=(8, 18))
        self.code_entry = tk.Entry(left, font=("Segoe UI", 28, "bold"), justify="center", width=6, bg="#1b2431", fg="#f5f8fc", insertbackground="#f5f8fc", relief="flat")
        self.code_entry.pack(anchor="w", ipady=8)
        tk.Button(left, text="Connect PC", command=self.connect_pc, bg="#80ed99", fg="#06070b", relief="flat", padx=14, pady=10, font=("Segoe UI", 11, "bold")).pack(anchor="w", pady=(16, 0))
        tk.Button(left, text="Disable PC", command=self.disable_pc, bg="#1b2431", fg="#f5f8fc", relief="flat", padx=14, pady=10, font=("Segoe UI", 11, "bold")).pack(anchor="w", pady=(10, 0))

        right = tk.Frame(body, bg="#131a24", padx=20, pady=20)
        right.grid(row=0, column=1, sticky="nsew", padx=(10, 0))
        tk.Label(right, text="Approved folder", bg="#131a24", fg="#f5f8fc", font=("Segoe UI", 24, "bold")).pack(anchor="w")
        tk.Label(right, text="Choose a folder ROTEX can work with after you approve actions.", bg="#131a24", fg="#9cadc1", wraplength=320, justify="left").pack(anchor="w", pady=(8, 18))
        self.folder_label = tk.Label(right, text="", bg="#1b2431", fg="#f5f8fc", wraplength=320, justify="left", padx=12, pady=12)
        self.folder_label.pack(anchor="w", fill="x")
        tk.Button(right, text="Choose folder", command=self.choose_folder, bg="#4cc9f0", fg="#06070b", relief="flat", padx=14, pady=10, font=("Segoe UI", 11, "bold")).pack(anchor="w", pady=(16, 0))

        footer = tk.Label(self, text="Keep this app open when using Computer mode from your phone. File edits still need approval.", bg="#06070b", fg="#647386", pady=12)
        footer.grid(row=2, column=0, sticky="ew")

    def render(self):
        connected = self.state_data.get("connected")
        folder = self.state_data.get("folder") or "No folder selected."
        self.status_label.config(text="Connected" if connected else "Not connected")
        self.folder_label.config(text=folder)

    def connect_pc(self):
        code = self.code_entry.get().strip()
        if len(code) != 3 or not code.isdigit():
            messagebox.showerror("ROTEX PC", "Enter the 3 digit code from your phone.")
            return
        self.state_data["connected"] = True
        self.state_data["code"] = code
        self.save_state()
        self.render()
        messagebox.showinfo("ROTEX PC", "PC connected. Now choose a folder if you want file access.")

    def choose_folder(self):
        if not self.state_data.get("connected"):
            messagebox.showerror("ROTEX PC", "Connect this PC first.")
            return
        folder = filedialog.askdirectory(title="Choose a ROTEX folder")
        if not folder:
            return
        self.state_data["folder"] = folder
        self.save_state()
        self.render()

    def disable_pc(self):
        self.state_data = {"connected": False, "code": "", "folder": "", "email": ""}
        self.save_state()
        self.render()


if __name__ == "__main__":
    app = RotexPcApp()
    app.mainloop()
