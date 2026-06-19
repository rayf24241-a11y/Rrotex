import json
import os
import threading
import tkinter as tk
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext, ttk


APP_URL = "https://www.rrotex.com"
CHAT_URL = f"{APP_URL}/api/chat"
STATE_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / "ROTEX"
STATE_PATH = STATE_DIR / "pc_state_v2.json"
HOME = Path.home()

BG = "#070a0f"
SIDEBAR = "#0b1018"
SURFACE = "#101722"
SURFACE_2 = "#151e2b"
SURFACE_3 = "#1b2636"
LINE = "#253144"
TEXT = "#f4f8ff"
MUTED = "#9aa8bb"
QUIET = "#68778d"
CYAN = "#5ddcff"
GREEN = "#7cf7a7"
AMBER = "#f9c74f"
RED = "#ff6b7a"
PURPLE = "#a78bfa"

TOOLS = ("Roblox", "Blender", "Unity")


class RotexPcApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("ROTEX Desktop")
        self.geometry("1240x780")
        self.minsize(1080, 700)
        self.configure(bg=BG)
        self.state_data = self.load_state()
        self.selected_path = None
        self.loaded_file = None
        self.tool_vars = {}
        self.node_paths = {}
        self.status_text = tk.StringVar(value="Ready")

        self.install_styles()
        self.main = tk.Frame(self, bg=BG)
        self.main.pack(fill="both", expand=True)
        self.build_workspace()
        if not self.state_data.get("setup_done"):
            self.after(250, self.open_project_setup)

    def install_styles(self):
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure(
            "Rotex.Treeview",
            background="#0c111a",
            foreground=TEXT,
            fieldbackground="#0c111a",
            bordercolor=LINE,
            rowheight=28,
            font=("Segoe UI", 10),
        )
        style.map("Rotex.Treeview", background=[("selected", "#1d3b52")], foreground=[("selected", TEXT)])
        style.configure(
            "Rotex.Vertical.TScrollbar",
            gripcount=0,
            background=SURFACE_3,
            darkcolor=SURFACE_3,
            lightcolor=SURFACE_3,
            troughcolor="#0c111a",
            bordercolor="#0c111a",
            arrowcolor=MUTED,
        )

    def load_state(self):
        if STATE_PATH.exists():
            try:
                return json.loads(STATE_PATH.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass
        return {
            "setup_done": False,
            "project_name": "",
            "tools": [],
            "root": str(HOME),
            "messages": [],
        }

    def save_state(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(self.state_data, indent=2), encoding="utf-8")

    def build_workspace(self):
        self.main.columnconfigure(0, weight=0)
        self.main.columnconfigure(1, weight=1)
        self.main.rowconfigure(0, weight=1)

        self.sidebar = tk.Frame(self.main, bg=SIDEBAR, width=286, padx=20, pady=22)
        self.sidebar.grid(row=0, column=0, sticky="ns")
        self.sidebar.grid_propagate(False)
        self.build_sidebar()

        body = tk.Frame(self.main, bg=BG, padx=26, pady=22)
        body.grid(row=0, column=1, sticky="nsew")
        body.columnconfigure(0, weight=1)
        body.rowconfigure(2, weight=1)

        self.build_header(body)
        self.build_status_cards(body)
        self.build_main_area(body)
        self.render()

    def build_sidebar(self):
        brand = tk.Frame(self.sidebar, bg=SIDEBAR)
        brand.pack(fill="x", anchor="w")
        tk.Label(brand, text="R", bg=CYAN, fg="#061018", width=2, height=1, font=("Segoe UI", 20, "bold")).pack(side="left")
        tk.Label(brand, text="  ROTEX", bg=SIDEBAR, fg=TEXT, font=("Segoe UI", 18, "bold")).pack(side="left")
        tk.Label(self.sidebar, text="Desktop agent workspace", bg=SIDEBAR, fg=QUIET, font=("Segoe UI", 9)).pack(anchor="w", pady=(8, 0))

        tk.Frame(self.sidebar, bg=LINE, height=1).pack(fill="x", pady=22)
        self.side_button("Project setup", self.open_project_setup, CYAN, dark_text=True).pack(fill="x", pady=(0, 10))
        self.side_button("Choose project folder", self.choose_root, SURFACE_3).pack(fill="x", pady=10)
        self.side_button("New chat", self.new_chat, SURFACE_3).pack(fill="x", pady=10)
        self.side_button("Open rrotex.com", lambda: webbrowser.open(APP_URL), SURFACE_3).pack(fill="x", pady=10)

        self.project_card = tk.Frame(self.sidebar, bg=SURFACE, padx=16, pady=16, highlightbackground=LINE, highlightthickness=1)
        self.project_card.pack(fill="x", pady=(24, 0))
        tk.Label(self.project_card, text="CURRENT PROJECT", bg=SURFACE, fg=QUIET, font=("Segoe UI", 8, "bold")).pack(anchor="w")
        self.project_name_label = tk.Label(
            self.project_card,
            text="",
            bg=SURFACE,
            fg=TEXT,
            font=("Segoe UI", 14, "bold"),
            anchor="w",
            wraplength=218,
            justify="left",
        )
        self.project_name_label.pack(fill="x", pady=(8, 4))
        self.project_tools_label = tk.Label(self.project_card, text="", bg=SURFACE, fg=CYAN, font=("Segoe UI", 10, "bold"), anchor="w")
        self.project_tools_label.pack(fill="x")

        tk.Frame(self.sidebar, bg=LINE, height=1).pack(fill="x", pady=22)
        tk.Label(self.sidebar, text="LOCAL ACCESS", bg=SIDEBAR, fg=QUIET, font=("Segoe UI", 8, "bold")).pack(anchor="w")
        tk.Label(
            self.sidebar,
            text="ROTEX can read selected files for context. File changes and commands should require approval before anything runs.",
            bg=SIDEBAR,
            fg=MUTED,
            wraplength=230,
            justify="left",
            font=("Segoe UI", 10),
        ).pack(anchor="w", pady=(8, 0))

        tk.Frame(self.sidebar, bg=SIDEBAR).pack(fill="both", expand=True)
        tk.Label(self.sidebar, textvariable=self.status_text, bg=SIDEBAR, fg=GREEN, font=("Segoe UI", 10, "bold")).pack(anchor="w")

    def build_header(self, body):
        header = tk.Frame(body, bg=BG)
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(0, weight=1)
        tk.Label(header, text="ROTEX Desktop", bg=BG, fg=TEXT, font=("Segoe UI", 28, "bold")).grid(row=0, column=0, sticky="w")
        self.header_subtitle = tk.Label(header, text="", bg=BG, fg=MUTED, font=("Segoe UI", 11), anchor="w")
        self.header_subtitle.grid(row=1, column=0, sticky="w", pady=(4, 0))
        self.header_chip = tk.Label(header, text="Local project mode", bg=SURFACE_2, fg=GREEN, padx=12, pady=7, font=("Segoe UI", 10, "bold"))
        self.header_chip.grid(row=0, column=1, rowspan=2, sticky="e")

    def build_status_cards(self, body):
        stats = tk.Frame(body, bg=BG)
        stats.grid(row=1, column=0, sticky="ew", pady=(20, 18))
        for column in range(4):
            stats.columnconfigure(column, weight=1)
        self.root_value = self.stat_card(stats, 0, "Folder", "No folder")
        self.file_value = self.stat_card(stats, 1, "Selected file", "None")
        self.model_value = self.stat_card(stats, 2, "Model", "Fast")
        self.mode_value = self.stat_card(stats, 3, "Mode", "Ask + files")

    def stat_card(self, parent, column, label, value):
        frame = tk.Frame(parent, bg=SURFACE, padx=14, pady=12, highlightbackground=LINE, highlightthickness=1)
        frame.grid(row=0, column=column, sticky="ew", padx=(0 if column == 0 else 8, 0 if column == 3 else 8))
        tk.Label(frame, text=label.upper(), bg=SURFACE, fg=QUIET, font=("Segoe UI", 8, "bold")).pack(anchor="w")
        value_label = tk.Label(frame, text=value, bg=SURFACE, fg=TEXT, font=("Segoe UI", 12, "bold"), anchor="w")
        value_label.pack(fill="x", pady=(6, 0))
        return value_label

    def build_main_area(self, body):
        area = tk.Frame(body, bg=BG)
        area.grid(row=2, column=0, sticky="nsew")
        area.columnconfigure(0, weight=1, minsize=360)
        area.columnconfigure(1, weight=2)
        area.rowconfigure(0, weight=1)

        left = tk.Frame(area, bg=BG)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 14))
        left.columnconfigure(0, weight=1)
        left.rowconfigure(0, weight=3)
        left.rowconfigure(1, weight=2)

        files = self.card(left, "Project files", "Browse the folder you picked")
        files.grid(row=0, column=0, sticky="nsew", pady=(0, 14))
        files.columnconfigure(0, weight=1)
        files.rowconfigure(2, weight=1)
        self.root_label = tk.Label(files, text="", bg="#0c111a", fg=MUTED, padx=10, pady=9, anchor="w", font=("Segoe UI", 10))
        self.root_label.grid(row=1, column=0, sticky="ew", pady=(0, 10))
        self.file_tree = ttk.Treeview(files, show="tree", style="Rotex.Treeview", height=12)
        self.file_tree.grid(row=2, column=0, sticky="nsew")
        self.file_tree.bind("<<TreeviewOpen>>", self.on_tree_open)
        self.file_tree.bind("<<TreeviewSelect>>", self.on_tree_select)
        file_actions = tk.Frame(files, bg=SURFACE)
        file_actions.grid(row=3, column=0, sticky="ew", pady=(12, 0))
        self.action_button(file_actions, "Preview file", self.read_selected_file, CYAN, dark_text=True).pack(side="left")

        preview = self.card(left, "File preview", "Loaded file context")
        preview.grid(row=1, column=0, sticky="nsew")
        preview.columnconfigure(0, weight=1)
        preview.rowconfigure(1, weight=1)
        self.file_preview = scrolledtext.ScrolledText(
            preview,
            height=9,
            bg="#070a0f",
            fg=TEXT,
            insertbackground=TEXT,
            relief="flat",
            padx=12,
            pady=10,
            wrap="none",
            font=("Consolas", 10),
        )
        self.file_preview.grid(row=1, column=0, sticky="nsew")
        self.file_preview.configure(state="disabled")

        chat = self.card(area, "AI chat", "Ask ROTEX about your project")
        chat.grid(row=0, column=1, sticky="nsew")
        chat.columnconfigure(0, weight=1)
        chat.rowconfigure(1, weight=1)
        self.chat_log = scrolledtext.ScrolledText(
            chat,
            bg="#070a0f",
            fg=TEXT,
            insertbackground=TEXT,
            relief="flat",
            padx=16,
            pady=16,
            wrap="word",
            font=("Segoe UI", 11),
        )
        self.chat_log.grid(row=1, column=0, sticky="nsew")

        composer = tk.Frame(chat, bg=SURFACE)
        composer.grid(row=2, column=0, sticky="ew", pady=(12, 0))
        composer.columnconfigure(0, weight=1)
        self.chat_input = tk.Entry(composer, bg=SURFACE_2, fg=TEXT, insertbackground=TEXT, relief="flat", font=("Segoe UI", 12))
        self.chat_input.grid(row=0, column=0, sticky="ew", ipady=13, padx=(0, 10))
        self.chat_input.bind("<Return>", lambda _event: self.send_message())
        self.send_button = self.action_button(composer, "Send", self.send_message, GREEN, dark_text=True)
        self.send_button.grid(row=0, column=1)

    def card(self, parent, title, subtitle):
        frame = tk.Frame(parent, bg=SURFACE, padx=16, pady=15, highlightbackground=LINE, highlightthickness=1)
        header = tk.Frame(frame, bg=SURFACE)
        header.grid(row=0, column=0, sticky="ew", pady=(0, 12))
        header.columnconfigure(0, weight=1)
        tk.Label(header, text=title, bg=SURFACE, fg=TEXT, font=("Segoe UI", 15, "bold")).grid(row=0, column=0, sticky="w")
        tk.Label(header, text=subtitle, bg=SURFACE, fg=QUIET, font=("Segoe UI", 9)).grid(row=1, column=0, sticky="w", pady=(3, 0))
        return frame

    def side_button(self, text, command, color, dark_text=False):
        fg = "#061018" if dark_text else TEXT
        return tk.Button(
            self.sidebar,
            text=text,
            command=command,
            bg=color,
            fg=fg,
            activebackground=color,
            activeforeground=fg,
            relief="flat",
            padx=14,
            pady=13,
            font=("Segoe UI", 10, "bold"),
            anchor="w",
        )

    def action_button(self, parent, text, command, color, dark_text=False):
        fg = "#061018" if dark_text else TEXT
        return tk.Button(
            parent,
            text=text,
            command=command,
            bg=color,
            fg=fg,
            activebackground=color,
            activeforeground=fg,
            relief="flat",
            padx=17,
            pady=11,
            font=("Segoe UI", 10, "bold"),
        )

    def render(self):
        name = self.state_data.get("project_name") or "No project yet"
        tools = self.state_data.get("tools") or []
        root = Path(self.state_data.get("root") or HOME)
        self.project_name_label.config(text=name)
        self.project_tools_label.config(text=" / ".join(tools) if tools else "Pick Roblox, Blender, or Unity")
        self.header_subtitle.config(text=f"{name} - {', '.join(tools) if tools else 'project setup needed'}")
        self.root_label.config(text=str(root))
        self.root_value.config(text=root.name or str(root))
        self.file_value.config(text=Path(self.loaded_file["path"]).name if self.loaded_file else "None")
        self.refresh_tree()
        self.render_messages()

    def open_project_setup(self):
        dialog = tk.Toplevel(self)
        dialog.title("Project setup")
        dialog.geometry("560x560")
        dialog.configure(bg=BG)
        dialog.transient(self)
        dialog.grab_set()

        card = tk.Frame(dialog, bg=SURFACE, padx=26, pady=24, highlightbackground=LINE, highlightthickness=1)
        card.pack(fill="both", expand=True, padx=18, pady=18)

        tk.Label(card, text="ROTEX SETUP", bg=SURFACE, fg=CYAN, font=("Segoe UI", 9, "bold")).pack(anchor="w")
        tk.Label(card, text="What are you building?", bg=SURFACE, fg=TEXT, font=("Segoe UI", 24, "bold")).pack(anchor="w", pady=(6, 6))
        tk.Label(card, text="Pick up to two tools so ROTEX can tune the workspace.", bg=SURFACE, fg=MUTED, font=("Segoe UI", 11)).pack(anchor="w", pady=(0, 18))

        tool_box = tk.Frame(card, bg=SURFACE)
        tool_box.pack(fill="x")
        current_tools = set(self.state_data.get("tools") or [])
        self.tool_vars = {}
        for tool in TOOLS:
            var = tk.BooleanVar(value=tool in current_tools)
            self.tool_vars[tool] = var
            row = tk.Checkbutton(
                tool_box,
                text=tool,
                variable=var,
                command=lambda: self.enforce_tool_limit(),
                bg=SURFACE_2,
                fg=TEXT,
                selectcolor="#0c111a",
                activebackground=SURFACE_2,
                activeforeground=TEXT,
                font=("Segoe UI", 13, "bold"),
                anchor="w",
                padx=12,
                pady=10,
                relief="flat",
            )
            row.pack(fill="x", pady=5)

        tk.Label(card, text="PROJECT NAME", bg=SURFACE, fg=QUIET, font=("Segoe UI", 8, "bold")).pack(anchor="w", pady=(20, 7))
        name_input = tk.Entry(card, bg="#0c111a", fg=TEXT, insertbackground=TEXT, relief="flat", font=("Segoe UI", 13))
        name_input.insert(0, self.state_data.get("project_name") or "")
        name_input.pack(fill="x", ipady=11)

        error_label = tk.Label(card, text="", bg=SURFACE, fg=RED, font=("Segoe UI", 10), anchor="w")
        error_label.pack(fill="x", pady=(10, 0))

        actions = tk.Frame(card, bg=SURFACE)
        actions.pack(side="bottom", fill="x", pady=(18, 0))

        def save_setup():
            selected = [tool for tool, var in self.tool_vars.items() if var.get()]
            project_name = name_input.get().strip()
            if not selected:
                error_label.config(text="Pick at least one tool.")
                return
            if len(selected) > 2:
                error_label.config(text="Pick up to two tools.")
                return
            if not project_name:
                error_label.config(text="Name your project.")
                return
            self.state_data["setup_done"] = True
            self.state_data["tools"] = selected
            self.state_data["project_name"] = project_name
            self.save_state()
            dialog.destroy()
            self.render()

        self.action_button(actions, "Save project", save_setup, GREEN, dark_text=True).pack(side="right")
        self.action_button(actions, "Cancel", dialog.destroy, SURFACE_3).pack(side="right", padx=(0, 10))
        self.enforce_tool_limit()
        name_input.focus()

    def enforce_tool_limit(self):
        selected = [tool for tool, var in self.tool_vars.items() if var.get()]
        if len(selected) <= 2:
            return
        last = selected[-1]
        self.tool_vars[last].set(False)
        messagebox.showinfo("ROTEX", "Pick up to two tools.")

    def refresh_tree(self):
        root = Path(self.state_data.get("root") or HOME)
        self.file_tree.delete(*self.file_tree.get_children())
        self.node_paths = {}
        root_id = self.file_tree.insert("", "end", text=root.name or str(root), open=True)
        self.node_paths[root_id] = str(root)
        self.add_children(root_id, root)

    def add_children(self, node_id, path):
        try:
            children = sorted(path.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))[:120]
        except Exception:
            return
        for child in children:
            label = child.name + ("/" if child.is_dir() else "")
            child_id = self.file_tree.insert(node_id, "end", text=label)
            self.node_paths[child_id] = str(child)
            if child.is_dir():
                self.file_tree.insert(child_id, "end", text="Loading...")

    def on_tree_open(self, _event):
        node_id = self.file_tree.focus()
        path = self.node_path(node_id)
        if not path or not path.is_dir():
            return
        children = self.file_tree.get_children(node_id)
        if len(children) == 1 and children[0] not in self.node_paths:
            self.file_tree.delete(children[0])
            self.add_children(node_id, path)

    def on_tree_select(self, _event):
        self.selected_path = self.node_path(self.file_tree.focus())
        if self.selected_path:
            self.file_value.config(text=self.selected_path.name)

    def node_path(self, node_id):
        value = self.node_paths.get(node_id)
        if not value:
            return None
        return Path(value)

    def choose_root(self):
        folder = filedialog.askdirectory(title="Choose project folder")
        if not folder:
            return
        self.state_data["root"] = folder
        self.save_state()
        self.status_text.set("Folder connected")
        self.render()

    def read_selected_file(self):
        path = self.selected_path
        if not path:
            messagebox.showinfo("ROTEX", "Select a file first.")
            return
        if path.is_dir():
            messagebox.showinfo("ROTEX", "Select a file, not a folder.")
            return
        try:
            text = path.read_text(encoding="utf-8", errors="replace")[:16000]
        except Exception as error:
            messagebox.showerror("ROTEX", f"Could not read file: {error}")
            return
        self.loaded_file = {"path": str(path), "text": text}
        self.file_preview.configure(state="normal")
        self.file_preview.delete("1.0", "end")
        self.file_preview.insert("end", f"{path}\n\n{text}")
        self.file_preview.configure(state="disabled")
        self.status_text.set("File loaded")
        self.render()

    def render_messages(self):
        self.chat_log.configure(state="normal")
        self.chat_log.delete("1.0", "end")
        messages = self.state_data.get("messages") or []
        if not messages:
            messages = [{"role": "assistant", "text": "Connect a project folder, preview a file, then ask ROTEX what to build or fix."}]
        for message in messages[-60:]:
            role = "YOU" if message["role"] == "user" else "ROTEX"
            self.chat_log.insert("end", f"{role}\n", ("role",))
            self.chat_log.insert("end", f"{message['text']}\n\n")
        self.chat_log.tag_config("role", foreground=CYAN, font=("Segoe UI", 9, "bold"))
        self.chat_log.configure(state="disabled")
        self.chat_log.see("end")

    def add_message(self, role, text):
        self.state_data.setdefault("messages", []).append({"role": role, "text": text})
        self.save_state()
        self.render_messages()

    def new_chat(self):
        self.state_data["messages"] = []
        self.save_state()
        self.status_text.set("New chat started")
        self.render_messages()

    def send_message(self):
        text = self.chat_input.get().strip()
        if not text:
            return
        self.chat_input.delete(0, "end")
        self.add_message("user", text)
        self.send_button.config(state="disabled", text="Thinking...")
        self.status_text.set("Asking ROTEX...")
        threading.Thread(target=self.ask_backend, args=(text,), daemon=True).start()

    def ask_backend(self, text):
        context = [
            f"Project name: {self.state_data.get('project_name') or 'Unnamed'}",
            f"Project tools: {', '.join(self.state_data.get('tools') or [])}",
            f"Project root: {self.state_data.get('root') or HOME}",
        ]
        if self.loaded_file:
            context.append(f"Loaded file: {self.loaded_file['path']}\n{self.loaded_file['text'][:8000]}")

        payload = {
            "model": "fast",
            "mode": "editor",
            "projectContext": "\n\n".join(context),
            "messages": [{"role": "user", "content": text}],
            "texTokensLeft": 150000,
        }
        try:
            request = urllib.request.Request(
                CHAT_URL,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=45) as response:
                data = json.loads(response.read().decode("utf-8"))
            answer = data.get("text") or "No response returned."
        except urllib.error.HTTPError as error:
            try:
                data = json.loads(error.read().decode("utf-8"))
                answer = data.get("text") or "AI is not available right now."
            except Exception:
                answer = "AI is not available right now."
        except Exception:
            answer = "AI is not available right now. You can still preview files and open the website."
        self.after(0, lambda: self.finish_backend_answer(answer))

    def finish_backend_answer(self, answer):
        self.add_message("assistant", answer)
        self.send_button.config(state="normal", text="Send")
        self.status_text.set("Ready")


if __name__ == "__main__":
    app = RotexPcApp()
    app.mainloop()
