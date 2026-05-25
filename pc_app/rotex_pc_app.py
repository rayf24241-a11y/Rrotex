import json
import os
import shutil
import sys
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox


APP_URL = "https://www.rrotex.com"
STATE_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / "ROTEX"
STATE_PATH = STATE_DIR / "pc_state.json"
INSTALL_PATH = STATE_DIR / "ROTEX-PC-App.exe"


class RotexPcApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("ROTEX PC")
        self.geometry("940x620")
        self.minsize(820, 560)
        self.configure(bg="#06070b")
        self.state_data = self.load_state()
        self.main = tk.Frame(self, bg="#06070b")
        self.main.pack(fill="both", expand=True)
        if not self.state_data.get("installed"):
            self.show_install()
        else:
            self.show_app()

    def load_state(self):
        if STATE_PATH.exists():
            try:
                return json.loads(STATE_PATH.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass
        return {
            "installed": False,
            "logged_in": False,
            "email": "",
            "connected": False,
            "code": "",
            "folder": "",
        }

    def save_state(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(self.state_data, indent=2), encoding="utf-8")

    def clear(self):
        for child in self.main.winfo_children():
            child.destroy()

    def show_install(self):
        self.clear()
        self.main.columnconfigure(0, weight=1)
        self.main.rowconfigure(0, weight=1)

        card = tk.Frame(self.main, bg="#0d1118", padx=34, pady=32)
        card.grid(row=0, column=0, sticky="", padx=28, pady=28)

        tk.Label(card, text="ROTEX PC", bg="#0d1118", fg="#f5f8fc", font=("Segoe UI", 40, "bold")).pack(anchor="w")
        tk.Label(
            card,
            text="Setting up your computer workspace.",
            bg="#0d1118",
            fg="#9cadc1",
            font=("Segoe UI", 13),
        ).pack(anchor="w", pady=(8, 26))

        self.install_status = tk.Label(card, text="Ready", bg="#0d1118", fg="#80ed99", font=("Segoe UI", 14, "bold"))
        self.install_status.pack(anchor="w")

        self.install_steps = tk.Text(card, width=62, height=9, bg="#131a24", fg="#f5f8fc", relief="flat", padx=12, pady=12)
        self.install_steps.pack(fill="x", pady=(14, 18))
        self.install_steps.configure(state="disabled")

        self.progress = tk.Canvas(card, width=520, height=10, bg="#1b2431", highlightthickness=0)
        self.progress.pack(fill="x")
        self.progress_bar = self.progress.create_rectangle(0, 0, 0, 10, fill="#80ed99", outline="")

        self.after(450, lambda: self.run_install_step(0))

    def install_log(self, text):
        self.install_steps.configure(state="normal")
        self.install_steps.insert("end", f"{text}\n")
        self.install_steps.see("end")
        self.install_steps.configure(state="disabled")

    def run_install_step(self, index):
        steps = [
            ("Installing ROTEX PC...", self.copy_to_appdata),
            ("Moving app to path...", self.copy_to_appdata),
            ("Making shortcut...", self.make_shortcut),
            ("Preparing secure workspace...", self.prepare_workspace),
            ("Finishing setup...", self.finish_install),
        ]
        if index >= len(steps):
            self.install_status.config(text="Done")
            self.after(650, self.show_app)
            return
        label, action = steps[index]
        self.install_status.config(text=label)
        self.install_log(label)
        try:
            action()
        except Exception as error:
            self.install_log(f"Skipped: {error}")
        width = 520 * ((index + 1) / len(steps))
        self.progress.coords(self.progress_bar, 0, 0, width, 10)
        self.after(650, lambda: self.run_install_step(index + 1))

    def copy_to_appdata(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        current = Path(sys.executable)
        if current.exists() and current.resolve() != INSTALL_PATH.resolve():
            shutil.copy2(current, INSTALL_PATH)

    def make_shortcut(self):
        desktop = Path.home() / "Desktop"
        shortcut = desktop / "ROTEX PC.url"
        target = INSTALL_PATH if INSTALL_PATH.exists() else Path(sys.executable)
        shortcut.write_text(f"[InternetShortcut]\nURL=file:///{target.as_posix()}\n", encoding="utf-8")

    def prepare_workspace(self):
        (STATE_DIR / "workspace").mkdir(parents=True, exist_ok=True)

    def finish_install(self):
        self.state_data["installed"] = True
        self.save_state()

    def show_app(self):
        self.clear()
        self.main.columnconfigure(0, weight=0)
        self.main.columnconfigure(1, weight=1)
        self.main.rowconfigure(0, weight=1)

        sidebar = tk.Frame(self.main, bg="#0d1118", padx=20, pady=20)
        sidebar.grid(row=0, column=0, sticky="ns")
        tk.Label(sidebar, text="R", bg="#4cc9f0", fg="#06070b", width=3, height=1, font=("Segoe UI", 20, "bold")).pack(anchor="w")
        tk.Label(sidebar, text="ROTEX", bg="#0d1118", fg="#f5f8fc", font=("Segoe UI", 18, "bold")).pack(anchor="w", pady=(14, 4))
        tk.Label(sidebar, text="PC workspace", bg="#0d1118", fg="#647386", font=("Segoe UI", 10, "bold")).pack(anchor="w")
        self.login_button = self.side_button(sidebar, "Log into Google", self.open_google_login)
        self.login_button.pack(fill="x", pady=(28, 8))
        self.return_button = self.side_button(sidebar, "I am logged in", self.mark_logged_in)
        self.return_button.pack(fill="x", pady=8)
        self.disable_button = self.side_button(sidebar, "Disable PC", self.disable_pc)
        self.disable_button.pack(fill="x", pady=8)

        body = tk.Frame(self.main, bg="#06070b", padx=28, pady=24)
        body.grid(row=0, column=1, sticky="nsew")
        body.columnconfigure(0, weight=1)
        body.columnconfigure(1, weight=1)
        body.rowconfigure(2, weight=1)

        tk.Label(body, text="Computer mode", bg="#06070b", fg="#80ed99", font=("Segoe UI", 11, "bold")).grid(row=0, column=0, columnspan=2, sticky="w")
        tk.Label(body, text="ROTEX PC", bg="#06070b", fg="#f5f8fc", font=("Segoe UI", 42, "bold")).grid(row=1, column=0, columnspan=2, sticky="w", pady=(4, 20))

        self.account_card = self.card(body, "Account", "Log into Google first so this PC can match your ROTEX account.")
        self.account_card.grid(row=2, column=0, sticky="nsew", padx=(0, 10), pady=(0, 12))
        self.account_status = self.value_label(self.account_card)
        self.account_status.pack(anchor="w", fill="x", pady=(12, 0))

        self.pair_card = self.card(body, "Pair with phone", "Make a 3 digit code on your phone, then type it here.")
        self.pair_card.grid(row=2, column=1, sticky="nsew", padx=(10, 0), pady=(0, 12))
        self.code_entry = tk.Entry(self.pair_card, font=("Segoe UI", 30, "bold"), justify="center", width=6, bg="#1b2431", fg="#f5f8fc", insertbackground="#f5f8fc", relief="flat")
        self.code_entry.pack(anchor="w", ipady=8, pady=(14, 10))
        self.action_button(self.pair_card, "Connect PC", self.connect_pc, "#80ed99").pack(anchor="w")

        self.folder_card = self.card(body, "Approved folder", "Choose a folder ROTEX can use after you approve file actions.")
        self.folder_card.grid(row=3, column=0, columnspan=2, sticky="nsew", pady=(10, 0))
        self.folder_status = self.value_label(self.folder_card)
        self.folder_status.pack(anchor="w", fill="x", pady=(12, 12))
        self.action_button(self.folder_card, "Choose folder", self.choose_folder, "#4cc9f0").pack(anchor="w")

        self.footer = tk.Label(body, text="", bg="#06070b", fg="#647386", font=("Segoe UI", 10))
        self.footer.grid(row=4, column=0, columnspan=2, sticky="w", pady=(18, 0))
        self.render()

    def card(self, parent, title, subtitle):
        frame = tk.Frame(parent, bg="#131a24", padx=20, pady=18)
        tk.Label(frame, text=title, bg="#131a24", fg="#f5f8fc", font=("Segoe UI", 20, "bold")).pack(anchor="w")
        tk.Label(frame, text=subtitle, bg="#131a24", fg="#9cadc1", wraplength=360, justify="left").pack(anchor="w", pady=(6, 0))
        return frame

    def value_label(self, parent):
        return tk.Label(parent, text="", bg="#1b2431", fg="#f5f8fc", wraplength=720, justify="left", padx=12, pady=12)

    def side_button(self, parent, text, command):
        return tk.Button(parent, text=text, command=command, bg="#131a24", fg="#f5f8fc", activebackground="#1b2431", activeforeground="#f5f8fc", relief="flat", padx=14, pady=11, font=("Segoe UI", 10, "bold"))

    def action_button(self, parent, text, command, color):
        return tk.Button(parent, text=text, command=command, bg=color, fg="#06070b", activebackground=color, relief="flat", padx=16, pady=11, font=("Segoe UI", 11, "bold"))

    def render(self):
        if not hasattr(self, "account_status"):
            return
        logged_in = self.state_data.get("logged_in")
        connected = self.state_data.get("connected")
        folder = self.state_data.get("folder") or "No folder selected."
        self.account_status.config(text="Google connected" if logged_in else "Not logged in")
        self.folder_status.config(text=folder)
        self.footer.config(text="Connected. Keep this app open while using ROTEX Computer mode." if connected else "Not connected yet.")

    def open_google_login(self):
        webbrowser.open(f"{APP_URL}/?pc_login=1")
        messagebox.showinfo("ROTEX PC", "Log into Google in the browser. When you are done, come back and press 'I am logged in'.")

    def mark_logged_in(self):
        self.state_data["logged_in"] = True
        self.save_state()
        self.render()

    def connect_pc(self):
        if not self.state_data.get("logged_in"):
            messagebox.showerror("ROTEX PC", "Log into Google first.")
            return
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
        self.state_data.update({"connected": False, "code": "", "folder": ""})
        self.save_state()
        self.render()


if __name__ == "__main__":
    app = RotexPcApp()
    app.mainloop()
