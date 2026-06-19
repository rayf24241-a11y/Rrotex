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

BG = "#0b0f14"
SURFACE = "#111821"
PANEL = "#17212d"
PANEL_2 = "#1d2937"
LINE = "#2f3d4f"
TEXT = "#f7fafc"
MUTED = "#9fb1c7"
QUIET = "#68788c"
BLUE = "#4cc9f0"
GREEN = "#80ed99"
AMBER = "#ffd166"
RED = "#ff6b6b"

TOOLS = ("Roblox", "Blender", "Unity")


class RotexPcApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("ROTEX Desktop")
        self.geometry("1180x760")
        self.minsize(1040, 680)
        self.configure(bg=BG)
        self.state_data = self.load_state()
        self.selected_path = None
        self.loaded_file = None
        self.tool_vars = {}

        self.main = tk.Frame(self, bg=BG)
        self.main.pack(fill="both", expand=True)
        self.build_workspace()
        if not self.state_data.get("setup_done"):
            self.after(250, self.open_project_setup)

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

        self.sidebar = tk.Frame(self.main, bg=SURFACE, width=260, padx=18, pady=20)
        self.sidebar.grid(row=0, column=0, sticky="ns")
        self.sidebar.grid_propagate(False)

        brand = tk.Frame(self.sidebar, bg=SURFACE)
        brand.pack(fill="x", anchor="w")
        tk.Label(brand, text="R", bg=BLUE, fg=BG, width=2, height=1, font=("Segoe UI", 20, "bold")).pack(side="left")
        tk.Label(brand, text="  ROTEX", bg=SURFACE, fg=TEXT, font=("Segoe UI", 18, "bold")).pack(side="left")

        self.side_button("Project setup", self.open_project_setup, GREEN).pack(fill="x", pady=(28, 8))
        self.side_button("Choose folder", self.choose_root, BLUE).pack(fill="x", pady=8)
        self.side_button("New chat", self.new_chat, PANEL_2).pack(fill="x", pady=8)
        self.side_button("Open website", lambda: webbrowser.open(APP_URL), PANEL_2).pack(fill="x", pady=8)

        self.project_card = tk.Frame(self.sidebar, bg=BG, padx=14, pady=14, highlightbackground=LINE, highlightthickness=1)
        self.project_card.pack(fill="x", pady=(28, 0))
        self.project_name_label = tk.Label(self.project_card, text="", bg=BG, fg=TEXT, font=("Segoe UI", 12, "bold"), anchor="w", wraplength=205)
        self.project_name_label.pack(fill="x")
        self.project_tools_label = tk.Label(self.project_card, text="", bg=BG, fg=MUTED, font=("Segoe UI", 10), anchor="w", wraplength=205, justify="left")
        self.project_tools_label.pack(fill="x", pady=(6, 0))

        tk.Label(self.sidebar, text="SAFE LOCAL ACCESS", bg=SURFACE, fg=QUIET, font=("Segoe UI", 9, "bold")).pack(anchor="w", pady=(28, 8))
        tk.Label(
            self.sidebar,
            text="ROTEX can preview files you select. File edits and commands should be approved before anything changes.",
            bg=SURFACE,
            fg=MUTED,
            wraplength=216,
            justify="left",
        ).pack(anchor="w")

        body = tk.Frame(self.main, bg=BG, padx=26, pady=24)
        body.grid(row=0, column=1, sticky="nsew")
        body.columnconfigure(0, weight=1)
        body.rowconfigure(2, weight=1)

        header = tk.Frame(body, bg=BG)
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(0, weight=1)
        tk.Label(header, text="ROTEX Desktop", bg=BG, fg=TEXT, font=("Segoe UI", 30, "bold")).grid(row=0, column=0, sticky="w")
        self.header_subtitle = tk.Label(header, text="", bg=BG, fg=MUTED, font=("Segoe UI", 11), anchor="e")
        self.header_subtitle.grid(row=0, column=1, sticky="e")

        top = tk.Frame(body, bg=BG)
        top.grid(row=1, column=0, sticky="ew", pady=(20, 16))
        top.columnconfigure(0, weight=1)
        top.columnconfigure(1, weight=1)

        files = self.card(top, "Project files")
        files.grid(row=0, column=0, sticky="nsew", padx=(0, 10))
        files.columnconfigure(0, weight=1)
        files.rowconfigure(2, weight=1)
        self.root_label = tk.Label(files, text="", bg=PANEL_2, fg=TEXT, padx=10, pady=8, anchor="w")
        self.root_label.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        self.file_tree = ttk.Treeview(files, columns=("path",), show="tree", height=10)
        self.file_tree.grid(row=1, column=0, sticky="nsew")
        self.file_tree.bind("<<TreeviewOpen>>", self.on_tree_open)
        self.file_tree.bind("<<TreeviewSelect>>", self.on_tree_select)
        self.action_row = tk.Frame(files, bg=PANEL)
        self.action_row.grid(row=2, column=0, sticky="ew", pady=(10, 0))
        self.action_button(self.action_row, "Preview file", self.read_selected_file, BLUE).pack(side="left")

        preview = self.card(top, "Selected file preview")
        preview.grid(row=0, column=1, sticky="nsew", padx=(10, 0))
        preview.columnconfigure(0, weight=1)
        preview.rowconfigure(0, weight=1)
        self.file_preview = scrolledtext.ScrolledText(preview, height=13, bg="#090d12", fg=TEXT, insertbackground=TEXT, relief="flat", padx=12, pady=10, wrap="none")
        self.file_preview.grid(row=0, column=0, sticky="nsew")
        self.file_preview.configure(state="disabled")

        chat = self.card(body, "AI chat")
        chat.grid(row=2, column=0, sticky="nsew")
        chat.columnconfigure(0, weight=1)
        chat.rowconfigure(0, weight=1)
        self.chat_log = scrolledtext.ScrolledText(chat, bg="#090d12", fg=TEXT, insertbackground=TEXT, relief="flat", padx=14, pady=14, wrap="word")
        self.chat_log.grid(row=0, column=0, sticky="nsew")

        composer = tk.Frame(chat, bg=PANEL)
        composer.grid(row=1, column=0, sticky="ew", pady=(12, 0))
        composer.columnconfigure(0, weight=1)
        self.chat_input = tk.Entry(composer, bg=PANEL_2, fg=TEXT, insertbackground=TEXT, relief="flat", font=("Segoe UI", 12))
        self.chat_input.grid(row=0, column=0, sticky="ew", ipady=12, padx=(0, 10))
        self.chat_input.bind("<Return>", lambda _event: self.send_message())
        self.send_button = self.action_button(composer, "Send", self.send_message, GREEN)
        self.send_button.grid(row=0, column=1)

        self.render()

    def card(self, parent, title):
        frame = tk.Frame(parent, bg=PANEL, padx=16, pady=16, highlightbackground=LINE, highlightthickness=1)
        tk.Label(frame, text=title, bg=PANEL, fg=TEXT, font=("Segoe UI", 15, "bold")).grid(row=0, column=0, sticky="w", pady=(0, 10))
        return frame

    def side_button(self, text, command, color):
        fg = BG if color in (GREEN, BLUE, AMBER) else TEXT
        return tk.Button(self.sidebar, text=text, command=command, bg=color, fg=fg, activebackground=color, activeforeground=fg, relief="flat", padx=14, pady=13, font=("Segoe UI", 10, "bold"))

    def action_button(self, parent, text, command, color):
        fg = BG if color in (GREEN, BLUE, AMBER) else TEXT
        return tk.Button(parent, text=text, command=command, bg=color, fg=fg, activebackground=color, activeforeground=fg, relief="flat", padx=16, pady=10, font=("Segoe UI", 10, "bold"))

    def render(self):
        name = self.state_data.get("project_name") or "No project named yet"
        tools = self.state_data.get("tools") or []
        self.project_name_label.config(text=name)
        self.project_tools_label.config(text=", ".join(tools) if tools else "Pick Roblox, Blender, or Unity")
        self.header_subtitle.config(text=", ".join(tools) if tools else "Set up your project")
        self.root_label.config(text=self.state_data.get("root") or str(HOME))
        self.refresh_tree()
        self.render_messages()

    def open_project_setup(self):
        dialog = tk.Toplevel(self)
        dialog.title("Project setup")
        dialog.geometry("520x520")
        dialog.configure(bg=BG)
        dialog.transient(self)
        dialog.grab_set()

        card = tk.Frame(dialog, bg=SURFACE, padx=24, pady=22, highlightbackground=LINE, highlightthickness=1)
        card.pack(fill="both", expand=True, padx=18, pady=18)

        tk.Label(card, text="Project setup", bg=SURFACE, fg=GREEN, font=("Segoe UI", 10, "bold")).pack(anchor="w")
        tk.Label(card, text="What are you working on?", bg=SURFACE, fg=TEXT, font=("Segoe UI", 24, "bold")).pack(anchor="w", pady=(4, 8))
        tk.Label(card, text="Pick up to two tools, then name your project.", bg=SURFACE, fg=MUTED, font=("Segoe UI", 11)).pack(anchor="w", pady=(0, 18))

        current_tools = set(self.state_data.get("tools") or [])
        self.tool_vars = {}
        for tool in TOOLS:
            var = tk.BooleanVar(value=tool in current_tools)
            self.tool_vars[tool] = var
            row = tk.Checkbutton(
                card,
                text=tool,
                variable=var,
                command=lambda: self.enforce_tool_limit(),
                bg=SURFACE,
                fg=TEXT,
                selectcolor=PANEL_2,
                activebackground=SURFACE,
                activeforeground=TEXT,
                font=("Segoe UI", 13, "bold"),
                anchor="w",
            )
            row.pack(fill="x", pady=5)

        tk.Label(card, text="Project name", bg=SURFACE, fg=QUIET, font=("Segoe UI", 9, "bold")).pack(anchor="w", pady=(18, 6))
        name_input = tk.Entry(card, bg=PANEL_2, fg=TEXT, insertbackground=TEXT, relief="flat", font=("Segoe UI", 13))
        name_input.insert(0, self.state_data.get("project_name") or "")
        name_input.pack(fill="x", ipady=10)

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

        self.action_button(actions, "Save project", save_setup, GREEN).pack(side="right")
        self.action_button(actions, "Cancel", dialog.destroy, PANEL_2).pack(side="right", padx=(0, 10))
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
        root_id = self.file_tree.insert("", "end", text=root.name or str(root), values=(str(root),), open=True)
        self.add_children(root_id, root)

    def add_children(self, node_id, path):
        try:
            children = sorted(path.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))[:100]
        except Exception:
            return
        for child in children:
            label = child.name + ("/" if child.is_dir() else "")
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
        self.selected_path = self.node_path(self.file_tree.focus())

    def node_path(self, node_id):
        values = self.file_tree.item(node_id, "values")
        if not values or not values[0]:
            return None
        return Path(values[0])

    def choose_root(self):
        folder = filedialog.askdirectory(title="Choose project folder")
        if not folder:
            return
        self.state_data["root"] = folder
        self.save_state()
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

    def render_messages(self):
        self.chat_log.configure(state="normal")
        self.chat_log.delete("1.0", "end")
        messages = self.state_data.get("messages") or []
        if not messages:
            messages = [{"role": "assistant", "text": "Set up your project, choose a folder, then ask ROTEX what to build or fix."}]
        for message in messages[-60:]:
            prefix = "You" if message["role"] == "user" else "ROTEX"
            self.chat_log.insert("end", f"{prefix}: {message['text']}\n\n")
        self.chat_log.configure(state="disabled")
        self.chat_log.see("end")

    def add_message(self, role, text):
        self.state_data.setdefault("messages", []).append({"role": role, "text": text})
        self.save_state()
        self.render_messages()

    def new_chat(self):
        self.state_data["messages"] = []
        self.save_state()
        self.render_messages()

    def send_message(self):
        text = self.chat_input.get().strip()
        if not text:
            return
        self.chat_input.delete(0, "end")
        self.add_message("user", text)
        self.send_button.config(state="disabled", text="Thinking...")
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


if __name__ == "__main__":
    app = RotexPcApp()
    app.mainloop()
