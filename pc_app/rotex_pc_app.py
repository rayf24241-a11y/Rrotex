import json
import os
import shutil
import sys
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext, ttk


APP_URL = "https://www.rrotex.com"
STATE_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / "ROTEX"
STATE_PATH = STATE_DIR / "pc_state.json"
INSTALL_PATH = STATE_DIR / "ROTEX-PC-App.exe"
HOME = Path.home()

BG = "#06070b"
SIDEBAR = "#0d1118"
PANEL = "#131a24"
PANEL_2 = "#1b2431"
LINE = "#2c3748"
TEXT = "#f5f8fc"
MUTED = "#9cadc1"
QUIET = "#647386"
BLUE = "#4cc9f0"
GREEN = "#80ed99"
AMBER = "#ffd166"
PINK = "#ff6b9d"


class RotexPcApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("ROTEX PC")
        self.geometry("1120x720")
        self.minsize(980, 640)
        self.configure(bg=BG)
        self.state_data = self.load_state()
        self.pending_file = None
        self.selected_path = None
        self.main = tk.Frame(self, bg=BG)
        self.main.pack(fill="both", expand=True)
        if not self.state_data.get("installed"):
            self.show_install()
        else:
            self.show_workspace()

    def load_state(self):
        if STATE_PATH.exists():
            try:
                return json.loads(STATE_PATH.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass
        return {
            "installed": False,
            "logged_in": False,
            "login_method": "",
            "email": "",
            "github_connected": False,
            "root": str(HOME),
            "messages": [],
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

        card = tk.Frame(self.main, bg=SIDEBAR, padx=34, pady=32, highlightbackground=LINE, highlightthickness=1)
        card.grid(row=0, column=0, sticky="", padx=28, pady=28)

        tk.Label(card, text="ROTEX PC", bg=SIDEBAR, fg=TEXT, font=("Segoe UI", 40, "bold")).pack(anchor="w")
        tk.Label(
            card,
            text="Installing the local computer workspace.",
            bg=SIDEBAR,
            fg=MUTED,
            font=("Segoe UI", 13),
        ).pack(anchor="w", pady=(8, 26))

        self.install_status = tk.Label(card, text="Ready", bg=SIDEBAR, fg=GREEN, font=("Segoe UI", 14, "bold"))
        self.install_status.pack(anchor="w")

        self.install_steps = tk.Text(card, width=68, height=10, bg=PANEL, fg=TEXT, relief="flat", padx=12, pady=12)
        self.install_steps.pack(fill="x", pady=(14, 18))
        self.install_steps.configure(state="disabled")

        self.progress = tk.Canvas(card, width=560, height=10, bg=PANEL_2, highlightthickness=0)
        self.progress.pack(fill="x")
        self.progress_bar = self.progress.create_rectangle(0, 0, 0, 10, fill=GREEN, outline="")

        self.after(450, lambda: self.run_install_step(0))

    def install_log(self, text):
        self.install_steps.configure(state="normal")
        self.install_steps.insert("end", f"{text}\n")
        self.install_steps.see("end")
        self.install_steps.configure(state="disabled")

    def run_install_step(self, index):
        steps = [
            ("Installing ROTEX PC...", self.copy_to_appdata),
            ("Moving app to local path...", self.copy_to_appdata),
            ("Making desktop shortcut...", self.make_shortcut),
            ("Preparing local file workspace...", self.prepare_workspace),
            ("Finishing setup...", self.finish_install),
        ]
        if index >= len(steps):
            self.install_status.config(text="Done")
            self.after(650, self.show_workspace)
            return
        label, action = steps[index]
        self.install_status.config(text=label)
        self.install_log(label)
        try:
            action()
        except Exception as error:
            self.install_log(f"Skipped: {error}")
        width = 560 * ((index + 1) / len(steps))
        self.progress.coords(self.progress_bar, 0, 0, width, 10)
        self.after(650, lambda: self.run_install_step(index + 1))

    def copy_to_appdata(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        current = Path(sys.executable)
        if current.exists() and current.resolve() != INSTALL_PATH.resolve():
            shutil.copy2(current, INSTALL_PATH)

    def make_shortcut(self):
        desktop = HOME / "Desktop"
        shortcut = desktop / "ROTEX PC.url"
        target = INSTALL_PATH if INSTALL_PATH.exists() else Path(sys.executable)
        shortcut.write_text(f"[InternetShortcut]\nURL=file:///{target.as_posix()}\n", encoding="utf-8")

    def prepare_workspace(self):
        (STATE_DIR / "workspace").mkdir(parents=True, exist_ok=True)

    def finish_install(self):
        self.state_data["installed"] = True
        self.save_state()

    def show_workspace(self):
        self.clear()
        self.main.columnconfigure(0, weight=0)
        self.main.columnconfigure(1, weight=1)
        self.main.rowconfigure(0, weight=1)

        sidebar = tk.Frame(self.main, bg=SIDEBAR, padx=18, pady=18, width=286)
        sidebar.grid(row=0, column=0, sticky="ns")
        sidebar.grid_propagate(False)

        brand = tk.Frame(sidebar, bg=SIDEBAR)
        brand.pack(anchor="w", fill="x")
        tk.Label(brand, text="R", bg=BLUE, fg=BG, width=3, font=("Segoe UI", 18, "bold")).pack(side="left")
        tk.Label(brand, text=" ROTEX", bg=SIDEBAR, fg=TEXT, font=("Segoe UI", 17, "bold")).pack(side="left")

        self.side_button(sidebar, "New local chat", self.new_chat, GREEN).pack(fill="x", pady=(28, 10))
        self.side_button(sidebar, "Open website", self.open_website, BLUE).pack(fill="x", pady=6)
        self.side_button(sidebar, "Bot browser window", self.open_bot_browser, AMBER).pack(fill="x", pady=6)
        self.side_button(sidebar, "Connect GitHub", self.connect_github, PANEL).pack(fill="x", pady=6)
        self.side_button(sidebar, "Choose file root", self.choose_root, PANEL).pack(fill="x", pady=6)

        self.account_panel = tk.Frame(sidebar, bg="#0a0e15", padx=12, pady=12, highlightbackground=LINE, highlightthickness=1)
        self.account_panel.pack(side="bottom", fill="x", pady=(18, 0))
        self.account_name = tk.Label(self.account_panel, text="", bg="#0a0e15", fg=TEXT, font=("Segoe UI", 10, "bold"), anchor="w")
        self.account_name.pack(fill="x")
        self.account_subtitle = tk.Label(self.account_panel, text="", bg="#0a0e15", fg=MUTED, font=("Segoe UI", 9), anchor="w", wraplength=218, justify="left")
        self.account_subtitle.pack(fill="x", pady=(3, 10))
        self.login_button = self.side_button(self.account_panel, "Email or Google", self.show_login_dialog, PANEL)
        self.login_button.pack(fill="x")

        tk.Label(sidebar, text="LOCAL ACCESS", bg=SIDEBAR, fg=QUIET, font=("Segoe UI", 9, "bold")).pack(anchor="w", pady=(28, 8))
        self.safety_text = tk.Label(
            sidebar,
            text="Installed on this PC. ROTEX can browse local files here, but file changes should be approved before they happen.",
            bg=SIDEBAR,
            fg=MUTED,
            wraplength=232,
            justify="left",
        )
        self.safety_text.pack(anchor="w")
        self.status_label = tk.Label(sidebar, text="", bg=SIDEBAR, fg=GREEN, wraplength=232, justify="left")
        self.status_label.pack(anchor="w", pady=(18, 0))

        body = tk.Frame(self.main, bg=BG, padx=24, pady=20)
        body.grid(row=0, column=1, sticky="nsew")
        body.columnconfigure(0, weight=1)
        body.columnconfigure(1, weight=1)
        body.rowconfigure(2, weight=1)

        tk.Label(body, text="ROTEX computer", bg=BG, fg=GREEN, font=("Segoe UI", 10, "bold")).grid(row=0, column=0, columnspan=2, sticky="w")
        tk.Label(body, text="Computer mode", bg=BG, fg=TEXT, font=("Segoe UI", 42, "bold")).grid(row=1, column=0, sticky="w")
        tk.Label(body, text="Local PC workspace. No Drive/OneDrive pairing needed; GitHub is optional.", bg=BG, fg=MUTED, font=("Segoe UI", 12)).grid(row=1, column=1, sticky="e")

        file_card = self.card(body, "Files on this PC", "Browse from the selected root. ROTEX can inspect files you open here.")
        file_card.grid(row=2, column=0, sticky="nsew", padx=(0, 10), pady=(16, 0))
        file_card.rowconfigure(2, weight=1)
        file_card.columnconfigure(0, weight=1)
        self.root_label = tk.Label(file_card, text="", bg=PANEL_2, fg=TEXT, padx=10, pady=8, anchor="w")
        self.root_label.grid(row=0, column=0, sticky="ew", pady=(10, 10))
        self.file_tree = ttk.Treeview(file_card, columns=("path",), show="tree")
        self.file_tree.grid(row=2, column=0, sticky="nsew")
        self.file_tree.bind("<<TreeviewOpen>>", self.on_tree_open)
        self.file_tree.bind("<<TreeviewSelect>>", self.on_tree_select)
        self.action_button(file_card, "Read selected file", self.read_selected_file, BLUE).grid(row=3, column=0, sticky="w", pady=(12, 0))

        chat_card = self.card(body, "ROTEX local chat", "The bot can use the file preview and browser window for PC work.")
        chat_card.grid(row=2, column=1, sticky="nsew", padx=(10, 0), pady=(16, 0))
        chat_card.rowconfigure(1, weight=1)
        chat_card.columnconfigure(0, weight=1)
        self.chat_log = scrolledtext.ScrolledText(chat_card, bg="#0b0f16", fg=TEXT, insertbackground=TEXT, relief="flat", padx=12, pady=12, wrap="word")
        self.chat_log.grid(row=1, column=0, sticky="nsew", pady=(10, 10))
        composer = tk.Frame(chat_card, bg=PANEL)
        composer.grid(row=2, column=0, sticky="ew")
        composer.columnconfigure(0, weight=1)
        self.chat_input = tk.Entry(composer, bg=PANEL_2, fg=TEXT, insertbackground=TEXT, relief="flat", font=("Segoe UI", 11))
        self.chat_input.grid(row=0, column=0, sticky="ew", ipady=10, padx=(0, 8))
        self.chat_input.bind("<Return>", lambda _event: self.send_local_message())
        self.action_button(composer, "Send", self.send_local_message, GREEN).grid(row=0, column=1)

        self.render()

    def card(self, parent, title, subtitle):
        frame = tk.Frame(parent, bg=PANEL, padx=18, pady=16, highlightbackground=LINE, highlightthickness=1)
        tk.Label(frame, text=title, bg=PANEL, fg=TEXT, font=("Segoe UI", 18, "bold")).grid(row=0, column=0, sticky="w")
        tk.Label(frame, text=subtitle, bg=PANEL, fg=MUTED, justify="left", wraplength=420).grid(row=1, column=0, sticky="w", pady=(4, 0))
        return frame

    def side_button(self, parent, text, command, color):
        fg = BG if color in (GREEN, BLUE, AMBER) else TEXT
        return tk.Button(parent, text=text, command=command, bg=color, fg=fg, activebackground=color, activeforeground=fg, relief="flat", padx=14, pady=12, font=("Segoe UI", 10, "bold"))

    def action_button(self, parent, text, command, color):
        return tk.Button(parent, text=text, command=command, bg=color, fg=BG, activebackground=color, activeforeground=BG, relief="flat", padx=14, pady=10, font=("Segoe UI", 10, "bold"))

    def render(self):
        root = Path(self.state_data.get("root") or HOME)
        self.root_label.config(text=str(root))
        logged_in = self.state_data.get("logged_in")
        method = self.state_data.get("login_method") or "pc"
        email = self.state_data.get("email") or "Local PC account"
        self.account_name.config(text=email if logged_in else "Not signed in")
        self.account_subtitle.config(
            text=f"Signed in with {method}. Local computer mode is ready." if logged_in else "Choose email or Google for the PC app."
        )
        self.login_button.config(text="Switch account" if logged_in else "Email or Google")
        self.status_label.config(
            text="GitHub connected" if self.state_data.get("github_connected") else "GitHub optional. Local PC files are ready."
        )
        self.refresh_tree()
        self.render_messages()

    def refresh_tree(self):
        root = Path(self.state_data.get("root") or HOME)
        self.file_tree.delete(*self.file_tree.get_children())
        root_id = self.file_tree.insert("", "end", text=root.name or str(root), values=(str(root),), open=True)
        self.add_children(root_id, root)

    def add_children(self, node_id, path):
        try:
            children = sorted(path.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))[:80]
        except Exception:
            return
        for child in children:
            label = child.name + ("\\" if child.is_dir() else "")
            child_id = self.file_tree.insert(node_id, "end", text=label, values=(str(child),))
            if child.is_dir():
                self.file_tree.insert(child_id, "end", text="Loading...", values=("",))

    def on_tree_open(self, _event):
        node_id = self.file_tree.focus()
        path = self.node_path(node_id)
        if not path or not path.is_dir():
            return
        children = self.file_tree.get_children(node_id)
        if len(children) == 1 and not self.file_tree.item(children[0], "values")[0]:
            self.file_tree.delete(children[0])
            self.add_children(node_id, path)

    def on_tree_select(self, _event):
        node_id = self.file_tree.focus()
        self.selected_path = self.node_path(node_id)

    def node_path(self, node_id):
        values = self.file_tree.item(node_id, "values")
        if not values or not values[0]:
            return None
        return Path(values[0])

    def read_selected_file(self):
        path = self.selected_path
        if not path:
            messagebox.showinfo("ROTEX PC", "Select a file first.")
            return
        if path.is_dir():
            messagebox.showinfo("ROTEX PC", "Select a file, not a folder.")
            return
        try:
            text = path.read_text(encoding="utf-8", errors="replace")[:12000]
        except Exception as error:
            messagebox.showerror("ROTEX PC", f"Could not read file: {error}")
            return
        self.pending_file = {"path": str(path), "text": text}
        self.add_message("system", f"Loaded file: {path}\n\n{text[:2200]}")

    def render_messages(self):
        self.chat_log.configure(state="normal")
        self.chat_log.delete("1.0", "end")
        messages = self.state_data.get("messages") or []
        if not messages:
            messages = [
                {"role": "assistant", "text": "ROTEX PC is ready. I can inspect files you open here, launch a browser window, and help with local computer work."}
            ]
        for message in messages[-40:]:
            prefix = "You" if message["role"] == "user" else "ROTEX"
            self.chat_log.insert("end", f"{prefix}: {message['text']}\n\n")
        self.chat_log.configure(state="disabled")
        self.chat_log.see("end")

    def add_message(self, role, text):
        self.state_data.setdefault("messages", []).append({"role": role, "text": text})
        self.save_state()
        self.render_messages()

    def send_local_message(self):
        text = self.chat_input.get().strip()
        if not text:
            return
        self.chat_input.delete(0, "end")
        self.add_message("user", text)
        file_hint = ""
        if self.pending_file:
            file_hint = f"\n\nI have local file context from {self.pending_file['path']}."
        self.add_message(
            "assistant",
            "I can help with that from this PC app. File edits should be approved before changing anything."
            + file_hint
            + " For full AI responses, use the ROTEX website or connect the backend key to this desktop app next.",
        )

    def new_chat(self):
        self.state_data["messages"] = []
        self.save_state()
        self.render_messages()

    def open_website(self):
        webbrowser.open(APP_URL)

    def open_bot_browser(self):
        webbrowser.open(f"{APP_URL}/#account")
        messagebox.showinfo("ROTEX PC", "Opened ROTEX in its own browser window. Keep this PC app open for local file context.")

    def show_login_dialog(self):
        dialog = tk.Toplevel(self)
        dialog.title("ROTEX PC login")
        dialog.geometry("520x360")
        dialog.minsize(500, 340)
        dialog.configure(bg=BG)
        dialog.transient(self)
        dialog.grab_set()

        card = tk.Frame(dialog, bg=SIDEBAR, padx=26, pady=24, highlightbackground=LINE, highlightthickness=1)
        card.pack(fill="both", expand=True, padx=18, pady=18)
        tk.Label(card, text="ROTEX PC", bg=SIDEBAR, fg=GREEN, font=("Segoe UI", 10, "bold")).pack(anchor="w")
        tk.Label(card, text="Email or Google for PC app?", bg=SIDEBAR, fg=TEXT, font=("Segoe UI", 26, "bold")).pack(anchor="w", pady=(4, 10))
        tk.Label(
            card,
            text="This signs into the desktop workspace. Website login can still happen in the browser.",
            bg=SIDEBAR,
            fg=MUTED,
            wraplength=430,
            justify="left",
        ).pack(anchor="w", pady=(0, 18))

        email_input = tk.Entry(card, bg=PANEL_2, fg=TEXT, insertbackground=TEXT, relief="flat", font=("Segoe UI", 12))
        email_input.insert(0, self.state_data.get("email") or "")
        email_input.pack(fill="x", ipady=10, pady=(0, 12))

        actions = tk.Frame(card, bg=SIDEBAR)
        actions.pack(fill="x")
        self.action_button(actions, "Continue with email", lambda: self.finish_email_login(dialog, email_input), GREEN).pack(side="left", fill="x", expand=True, padx=(0, 6))
        self.action_button(actions, "Continue with Google", lambda: self.finish_google_login(dialog), BLUE).pack(side="left", fill="x", expand=True, padx=(6, 0))

        tk.Label(
            card,
            text="Local access stays on this PC. ROTEX should ask before changing files.",
            bg=SIDEBAR,
            fg=QUIET,
            wraplength=430,
            justify="left",
        ).pack(anchor="w", pady=(18, 0))

    def finish_email_login(self, dialog, email_input):
        email = email_input.get().strip()
        if "@" not in email:
            messagebox.showerror("ROTEX PC", "Enter an email first.")
            return
        self.state_data.update({"logged_in": True, "login_method": "email", "email": email})
        self.save_state()
        dialog.destroy()
        self.render()

    def finish_google_login(self, dialog):
        self.state_data.update({"logged_in": True, "login_method": "Google", "email": "Google account"})
        self.save_state()
        webbrowser.open(f"{APP_URL}/#authPage")
        dialog.destroy()
        self.render()
        messagebox.showinfo("ROTEX PC", "Google login opened in your browser. The PC app is marked ready.")

    def connect_github(self):
        self.state_data["github_connected"] = True
        self.save_state()
        webbrowser.open(f"{APP_URL}/api/connect/github")
        self.render()
        messagebox.showinfo("ROTEX PC", "GitHub connect opened. GitHub is optional in the PC app.")

    def choose_root(self):
        folder = filedialog.askdirectory(title="Choose the root ROTEX can browse")
        if not folder:
            return
        self.state_data["root"] = folder
        self.save_state()
        self.render()


if __name__ == "__main__":
    app = RotexPcApp()
    app.mainloop()
