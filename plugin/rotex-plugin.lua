-- ROTEX Studio Plugin v2.1
-- Connects Roblox Studio to the ROTEX AI desktop app.

local PORTS = {7878, 7874}
local HTTP_PORT = PORTS[1]

local HttpService          = game:GetService("HttpService")
local Selection            = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

-- ── Toolbar ───────────────────────────────────────────────────────────────────
local toolbar = plugin:CreateToolbar("ROTEX AI")
local btnOpen = toolbar:CreateButton("Open", "Open the ROTEX AI panel", "rbxassetid://0")

-- ── Dock widget ───────────────────────────────────────────────────────────────
local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right, false, false, 300, 580, 240, 380
)
local widget = plugin:CreateDockWidgetPluginGui("ROTEX_Panel", widgetInfo)
widget.Title = "ROTEX AI v2"
widget.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

-- ── Colors ────────────────────────────────────────────────────────────────────
local C = {
	bg       = Color3.fromRGB(13, 15, 23),
	surface  = Color3.fromRGB(20, 23, 32),
	panel    = Color3.fromRGB(26, 31, 46),
	border   = Color3.fromRGB(37, 45, 64),
	text     = Color3.fromRGB(232, 237, 248),
	muted    = Color3.fromRGB(138, 147, 170),
	quiet    = Color3.fromRGB(82, 92, 120),
	yellow   = Color3.fromRGB(255, 214, 10),
	yellowDk = Color3.fromRGB(13, 15, 23),
	blue     = Color3.fromRGB(37, 99, 235),
	green    = Color3.fromRGB(34, 197, 94),
	red      = Color3.fromRGB(255, 71, 87),
}

-- ── UI helpers ────────────────────────────────────────────────────────────────
local function Frame(parent, size, pos, bg, radius)
	local f = Instance.new("Frame")
	f.Size, f.Position, f.BackgroundColor3, f.BorderSizePixel = size, pos, bg or C.panel, 0
	f.Parent = parent
	if radius then Instance.new("UICorner", f).CornerRadius = UDim.new(0, radius) end
	return f
end

local function Label(parent, text, size, pos, color, fs, bold, wrap)
	local l = Instance.new("TextLabel")
	l.Size, l.Position = size, pos
	l.BackgroundTransparency = 1
	l.Text, l.TextColor3, l.TextSize = text, color or C.text, fs or 12
	l.Font = bold and Enum.Font.GothamBold or Enum.Font.Gotham
	l.TextXAlignment, l.TextYAlignment = Enum.TextXAlignment.Left, Enum.TextYAlignment.Top
	l.TextWrapped = wrap or false
	l.Parent = parent
	return l
end

local function Button(parent, text, size, pos, bg, textColor, fs)
	local b = Instance.new("TextButton")
	b.Size, b.Position, b.BackgroundColor3 = size, pos, bg or C.blue
	b.TextColor3, b.Text, b.TextSize = textColor or Color3.new(1,1,1), text, fs or 11
	b.Font, b.BorderSizePixel, b.AutoButtonColor = Enum.Font.GothamBold, 0, true
	b.Parent = parent
	Instance.new("UICorner", b).CornerRadius = UDim.new(0, 8)
	return b
end

-- ── Build UI ──────────────────────────────────────────────────────────────────
local root = Frame(widget, UDim2.new(1,0,1,0), UDim2.new(0,0,0,0), C.bg)

local hdr = Frame(root, UDim2.new(1,0,0,48), UDim2.new(0,0,0,0), C.surface)
Label(hdr, "ROTEX AI", UDim2.new(1,-14,0,20), UDim2.new(0,12,0,8), C.text, 14, true)
Label(hdr, "Studio Bridge v2.1", UDim2.new(1,-14,0,14), UDim2.new(0,12,0,28), C.muted, 9, false)
Frame(root, UDim2.new(1,0,0,1), UDim2.new(0,0,0,48), C.border)

local Y = 58

local connectBtn    = Button(root, "Connect to ROTEX", UDim2.new(1,-20,0,36), UDim2.new(0,10,0,Y), C.blue, Color3.new(1,1,1), 13)
Y = Y + 46

local statusLbl     = Label(root, "● Not connected", UDim2.new(1,-20,0,16), UDim2.new(0,12,0,Y), C.quiet, 11)
Y = Y + 20
local scriptCountLbl = Label(root, "", UDim2.new(1,-20,0,14), UDim2.new(0,12,0,Y), C.muted, 10)
Y = Y + 20

Frame(root, UDim2.new(1,-20,0,1), UDim2.new(0,10,0,Y), C.border)
Y = Y + 10

local disconnectBtn = Button(root, "Disconnect ROTEX", UDim2.new(1,-20,0,30), UDim2.new(0,10,0,Y), C.red, Color3.new(1,1,1), 11)
Y = Y + 38

local sendCtxBtn    = Button(root, "Send Context to ROTEX", UDim2.new(1,-20,0,36), UDim2.new(0,10,0,Y), C.yellow, C.yellowDk, 13)
Y = Y + 46

Frame(root, UDim2.new(1,-20,0,1), UDim2.new(0,10,0,Y), C.border)
Y = Y + 10
Label(root, "OUTPUT", UDim2.new(1,-20,0,14), UDim2.new(0,10,0,Y), C.quiet, 9, true)
Y = Y + 17

local outputScroll = Instance.new("ScrollingFrame")
outputScroll.Size                  = UDim2.new(1,-20,1,-(Y+10))
outputScroll.Position              = UDim2.new(0,10,0,Y)
outputScroll.BackgroundColor3      = C.panel
outputScroll.BorderSizePixel       = 0
outputScroll.ScrollBarThickness    = 4
outputScroll.ScrollBarImageColor3  = C.border
outputScroll.AutomaticCanvasSize   = Enum.AutomaticSize.Y
outputScroll.CanvasSize            = UDim2.new(0,0,0,0)
outputScroll.Parent = root
Instance.new("UICorner", outputScroll).CornerRadius = UDim.new(0, 8)

local outputText = Instance.new("TextBox")
outputText.Size                 = UDim2.new(1,-10,0,0)
outputText.Position             = UDim2.new(0,5,0,5)
outputText.BackgroundColor3     = C.panel
outputText.BackgroundTransparency = 0
outputText.BorderSizePixel      = 0
outputText.Text, outputText.TextColor3 = "", C.muted
outputText.TextSize, outputText.Font   = 10, Enum.Font.Code
outputText.TextXAlignment        = Enum.TextXAlignment.Left
outputText.TextYAlignment        = Enum.TextYAlignment.Top
outputText.TextWrapped, outputText.MultiLine = true, true
outputText.ClearTextOnFocus, outputText.TextEditable = false, true
outputText.Active, outputText.Selectable = true, true
outputText.AutomaticSize = Enum.AutomaticSize.Y
outputText.Parent = outputScroll

-- ── State ─────────────────────────────────────────────────────────────────────
local connected    = false
local currentToken = plugin:GetSetting("rotex_token") or ""
local projectName  = ""
local _connecting  = false

local function setStatus(text, color)
	statusLbl.Text, statusLbl.TextColor3 = text, color or C.quiet
end

local function setActionButtons(enabled)
	local a = enabled and 0 or 0.45
	disconnectBtn.BackgroundTransparency = a; disconnectBtn.Active = enabled
	sendCtxBtn.BackgroundTransparency    = a; sendCtxBtn.Active    = enabled
end

local function appendLog(text)
	local prev = outputText.Text
	outputText.Text = string.sub((prev == "" and text or (prev .. "\n" .. text)), -4000)
	task.defer(function()
		outputScroll.CanvasPosition = Vector2.new(0, outputScroll.AbsoluteCanvasSize.Y)
	end)
end

-- ── HTTP: GET with timeout ────────────────────────────────────────────────────
-- Uses GetAsync (simpler API, no body confusion, different HTTP path in Roblox)
local function getJSON(port, path, timeoutSecs)
	local token = currentToken:match("^%s*(.-)%s*$")
	local url   = "http://127.0.0.1:" .. port .. path .. "?token=" .. token
	local ref   = {done = false, data = nil, err = nil}
	task.spawn(function()
		local ok, body = pcall(function()
			return HttpService:GetAsync(url, true)
		end)
		if ok and type(body) == "string" then
			local ok2, decoded = pcall(function() return HttpService:JSONDecode(body) end)
			ref.data = ok2 and decoded or nil
			if not ok2 then ref.err = "bad JSON" end
		else
			ref.err = ok and "empty response" or tostring(body)
		end
		ref.done = true
	end)
	local t0 = tick()
	while not ref.done and (tick() - t0) < (timeoutSecs or 5) do task.wait(0.1) end
	return ref.data, ref.err
end

-- ── HTTP: POST with timeout ───────────────────────────────────────────────────
local function postJSON(port, path, body, timeoutSecs)
	local token = currentToken:match("^%s*(.-)%s*$")
	local url   = "http://127.0.0.1:" .. port .. path .. "?token=" .. token
	local ref   = {done = false, data = nil}
	task.spawn(function()
		local ok, res = pcall(function()
			return HttpService:RequestAsync({
				Url     = url,
				Method  = "POST",
				Headers = { ["Content-Type"] = "application/json" },
				Body    = body or "{}",
			})
		end)
		if ok and res and res.StatusCode == 200 then
			local ok2, decoded = pcall(function() return HttpService:JSONDecode(res.Body) end)
			ref.data = ok2 and decoded or { ok = true }
		end
		ref.done = true
	end)
	local t0 = tick()
	while not ref.done and (tick() - t0) < (timeoutSecs or 5) do task.wait(0.1) end
	return ref.data
end

-- ── Game scanner ──────────────────────────────────────────────────────────────
local SCAN_SERVICES = {
	"ServerScriptService", "ReplicatedStorage", "StarterPlayer",
	"StarterGui", "Workspace", "ServerStorage", "ReplicatedFirst",
}

local function scanAllScripts(maxScripts)
	maxScripts = maxScripts or 100
	local scripts = {}
	local function scanInst(inst, depth)
		if depth > 7 or #scripts >= maxScripts then return end
		local ok, children = pcall(function() return inst:GetChildren() end)
		if not ok then return end
		for _, child in ipairs(children) do
			if #scripts >= maxScripts then return end
			if child:IsA("LuaSourceContainer") then
				table.insert(scripts, {
					path   = child:GetFullName(),
					name   = child.Name,
					class  = child.ClassName,
					source = string.sub(child.Source or "", 1, 3000),
				})
			end
			scanInst(child, depth + 1)
		end
	end
	for _, svcName in ipairs(SCAN_SERVICES) do
		local ok, svc = pcall(function() return game:GetService(svcName) end)
		if ok and svc then scanInst(svc, 0) end
	end
	return scripts
end

local function buildGameContext(includeSelected)
	local scripts = scanAllScripts(100)
	local selected = {}
	if includeSelected then
		for _, obj in ipairs(Selection:Get()) do
			if obj:IsA("LuaSourceContainer") then
				table.insert(selected, {
					path   = obj:GetFullName(), name = obj.Name,
					class  = obj.ClassName,
					source = string.sub(obj.Source or "", 1, 5000),
				})
			elseif obj:IsA("BasePart") or obj:IsA("Model") then
				table.insert(selected, { path = obj:GetFullName(), name = obj.Name, class = obj.ClassName })
			end
		end
	end
	return { project = projectName, scripts = scripts, selected = selected }
end

-- ── Instance resolver ─────────────────────────────────────────────────────────
local function resolveByPath(fullPath)
	local parts = {}
	for part in string.gmatch(fullPath or "", "[^%.]+") do table.insert(parts, part) end
	if #parts == 0 then return nil end
	local ok, root = pcall(function()
		if parts[1] == "game" or parts[1] == "Game" then return game end
		return game:GetService(parts[1])
	end)
	if not ok or not root then return nil end
	local cur = root
	for i = 2, #parts do
		local child = cur:FindFirstChild(parts[i])
		if not child then return nil end
		cur = child
	end
	return cur
end

-- ── Script apply ──────────────────────────────────────────────────────────────
local function splitPath(p) local t={} for s in string.gmatch(p or "","[^/\\]+") do table.insert(t,s) end return t end
local function studioRoot(n) local ok,s=pcall(function() return game:GetService(n) end) return (ok and s) or workspace end
local function scriptClassFor(name, source)
	local lower = string.lower(name or "")
	if string.find(lower, "localscript") or string.find(lower, "%.client%.lua$") then return "LocalScript" end
	if string.find(lower, "modulescript") or string.find(lower, "%.module%.lua$")
		or string.find(source or "", "[\r\n]%s*return%s+[%w_%.]+%s*$") then return "ModuleScript" end
	return "Script"
end
local function cleanName(n)
	return (n or "ROTEXScript"):gsub("%.client%.lua$",""):gsub("%.server%.lua$","")
		:gsub("%.module%.lua$",""):gsub("%.lua$","")
end

local function applyStudioFile(file)
	local parts = splitPath(file.path)
	if #parts < 2 then return false, "Bad path: " .. tostring(file.path) end
	local parent = studioRoot(parts[1])
	for i = 2, #parts - 1 do
		local folder = parent:FindFirstChild(parts[i])
		if not folder then folder = Instance.new("Folder") folder.Name = parts[i] folder.Parent = parent end
		parent = folder
	end
	local scriptName = cleanName(parts[#parts])
	local source = file.content or ""
	local existing = parent:FindFirstChild(scriptName)
	if existing and existing:IsA("LuaSourceContainer") then
		existing.Source = source; return true, "Updated " .. file.path
	end
	local obj = Instance.new(scriptClassFor(parts[#parts], source))
	obj.Name, obj.Source, obj.Parent = scriptName, source, parent
	return true, "Created " .. file.path
end

local function handleCreateModel(action)
	ChangeHistoryService:SetWaypoint("ROTEX CreateModel")
	local parentInst = workspace
	local parentName = action.parent or "Workspace"
	if string.find(parentName, "[/\\%.]") then
		parentInst = resolveByPath(parentName) or workspace
	else
		local ok, svc = pcall(function() return studioRoot(parentName) end)
		if ok then parentInst = svc end
	end
	local model = Instance.new("Model")
	model.Name, model.Parent = action.name or "ROTEXModel", parentInst
	local msgs = {"Created model: " .. model.Name}
	for _, pd in ipairs(action.parts or {}) do
		local part = Instance.new(pd.class or "Part")
		part.Name = pd.name or "Part"
		if pd.size then part.Size = Vector3.new(pd.size[1] or 4, pd.size[2] or 4, pd.size[3] or 4) end
		if pd.position then
			part.CFrame = CFrame.new(pd.position[1] or 0, pd.position[2] or 5, pd.position[3] or 0)
			if pd.rotation then
				part.CFrame = part.CFrame * CFrame.Angles(math.rad(pd.rotation[1] or 0), math.rad(pd.rotation[2] or 0), math.rad(pd.rotation[3] or 0))
			end
		end
		if pd.color then
			if type(pd.color) == "table" then part.Color = Color3.fromRGB(pd.color[1] or 128, pd.color[2] or 128, pd.color[3] or 128)
			else local ok2,bc = pcall(function() return BrickColor.new(tostring(pd.color)) end) if ok2 then part.BrickColor = bc end end
		end
		if pd.material and part:IsA("BasePart") then
			local ok2, mat = pcall(function() return Enum.Material[pd.material] end) if ok2 then part.Material = mat end
		end
		if pd.shape and part:IsA("Part") then
			local ok2, sh = pcall(function() return Enum.PartType[pd.shape] end) if ok2 then part.Shape = sh end
		end
		if part:IsA("BasePart") then
			part.Anchored   = (pd.anchored ~= false)
			part.CanCollide = (pd.cancollide ~= false)
			if pd.transparency ~= nil then part.Transparency = pd.transparency end
			if pd.castShadow  ~= nil then part.CastShadow   = pd.castShadow  end
		end
		for _, sc in ipairs(pd.scripts or {}) do
			local s = Instance.new(scriptClassFor(sc.name or "Script", sc.source or ""))
			s.Name, s.Source, s.Parent = cleanName(sc.name or "Script"), sc.source or "", part
		end
		part.Parent = model
		table.insert(msgs, "  + " .. part.Name .. " (" .. (pd.class or "Part") .. ")")
	end
	for _, sc in ipairs(action.scripts or {}) do
		local s = Instance.new(scriptClassFor(sc.name or "Script", sc.source or ""))
		s.Name, s.Source, s.Parent = cleanName(sc.name or "Script"), sc.source or "", model
	end
	if action.primaryPart then
		local pp = model:FindFirstChild(action.primaryPart)
		if pp and pp:IsA("BasePart") then model.PrimaryPart = pp end
	end
	ChangeHistoryService:SetWaypoint("ROTEX CreateModel Done")
	return true, table.concat(msgs, "\n")
end

local function handleSetProperty(action)
	local inst = resolveByPath(action.path or "")
	if not inst then return false, "Not found: " .. tostring(action.path) end
	local ok, err = pcall(function() inst[action.property] = action.value end)
	return ok, ok and ("Set " .. action.path .. "." .. action.property) or tostring(err)
end

local function handleDeleteInstance(action)
	local inst = resolveByPath(action.path or "")
	if not inst then return false, "Not found: " .. tostring(action.path) end
	ChangeHistoryService:SetWaypoint("ROTEX Delete")
	inst:Destroy()
	ChangeHistoryService:SetWaypoint("ROTEX Delete Done")
	return true, "Deleted " .. tostring(action.path)
end

local function handleSelectInstances(action)
	local targets = {}
	for _, p in ipairs(action.paths or {}) do
		local inst = resolveByPath(p)
		if inst then table.insert(targets, inst) end
	end
	Selection:Set(targets)
	return true, "Selected " .. #targets .. " instances"
end

-- ── Connect ───────────────────────────────────────────────────────────────────
local function doConnect(manual)
	if _connecting then
		if manual then appendLog("[ROTEX] Already connecting, please wait…") end
		return
	end
	_connecting = true

	if manual then
		setStatus("● Connecting…", C.yellow)
		connectBtn.Text = "Connecting…"
		appendLog("[ROTEX] Trying ports " .. table.concat(PORTS, ", ") .. "…")
	end
	scriptCountLbl.Text = ""

	local connPort, connData
	for _, port in ipairs(PORTS) do
		local data, err = getJSON(port, "/ping", 5)
		if data and data.ok then
			connPort = port
			connData = data
			break
		end
		if manual then
			appendLog("[ROTEX] Port " .. port .. ": " .. (err or "no response"))
		end
	end

	_connecting = false

	if connPort then
		HTTP_PORT = connPort
		local token = (connData.token or ""):match("^%s*(.-)%s*$")
		if #token >= 4 then
			currentToken = token
			plugin:SetSetting("rotex_token", token)
		end
		connected   = true
		projectName = connData.project or ""
		setActionButtons(true)
		connectBtn.Text = "Reconnect"
		setStatus("✓ Connected to ROTEX", C.green)
		appendLog("[ROTEX] Connected on port " .. connPort .. (projectName ~= "" and (" — " .. projectName) or ""))

		-- Auto-start Rojo
		task.spawn(function()
			local r = postJSON(HTTP_PORT, "/rojo/start", "{}", 5)
			if r then
				setStatus("✓✓ Connected + Rojo", C.green)
				appendLog("[Rojo] Started — syncing files")
			else
				appendLog("[Rojo] Not available (install from rojo.space)")
			end
		end)

		-- Send initial context
		task.spawn(function()
			appendLog("[Scan] Reading game scripts…")
			local ctx = buildGameContext(false)
			local n = #(ctx.scripts or {})
			scriptCountLbl.Text = n .. " scripts found"
			local body = HttpService:JSONEncode(ctx)
			postJSON(HTTP_PORT, "/ai/start", body, 8)
			appendLog("[Scan] Sent " .. n .. " scripts to ROTEX — ready to chat!")
		end)
	else
		connectBtn.Text = "Connect to ROTEX"
		if manual then
			setStatus("● Not connected", C.quiet)
			appendLog("[ROTEX] Could not reach ROTEX — is the desktop app open?")
		end
	end
end

-- ── Disconnect ────────────────────────────────────────────────────────────────
disconnectBtn.MouseButton1Click:Connect(function()
	if not connected then return end
	task.spawn(function() postJSON(HTTP_PORT, "/rojo/stop", "{}", 3) end)
	connected = false
	setActionButtons(false)
	connectBtn.Text = "Connect to ROTEX"
	setStatus("● Not connected", C.quiet)
	scriptCountLbl.Text = ""
	appendLog("[ROTEX] Disconnected")
end)

-- ── Send Context ──────────────────────────────────────────────────────────────
sendCtxBtn.MouseButton1Click:Connect(function()
	if not connected then return end
	appendLog("[Context] Scanning game…")
	task.spawn(function()
		local ctx = buildGameContext(true)
		local n = #(ctx.scripts or {})
		local s = #(ctx.selected or {})
		scriptCountLbl.Text = n .. " scripts" .. (s > 0 and (" · " .. s .. " selected") or "")
		postJSON(HTTP_PORT, "/ai/start", HttpService:JSONEncode(ctx), 8)
		appendLog("[Context] Sent " .. n .. " scripts" .. (s > 0 and (", " .. s .. " selected") or ""))
	end)
end)

-- ── Connect button ────────────────────────────────────────────────────────────
connectBtn.MouseButton1Click:Connect(function()
	task.spawn(doConnect, true)
end)

-- ── Toolbar toggle ────────────────────────────────────────────────────────────
btnOpen.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

-- ── Action poll loop (1s) ─────────────────────────────────────────────────────
task.spawn(function()
	while true do
		task.wait(1)
		if not connected then continue end
		local data = getJSON(HTTP_PORT, "/studio/actions", 4)
		if not data then continue end
		local action = data.action
		if not action then continue end

		local msgs, success = {}, true
		local function addMsg(value)
			table.insert(msgs, tostring(value or "ok"))
		end

		if action.type == "apply_files" and type(action.files) == "table" then
			ChangeHistoryService:SetWaypoint("ROTEX ApplyFiles")
			for _, file in ipairs(action.files) do
				local callOk, fileOk, msg = pcall(applyStudioFile, file)
				success = success and callOk and fileOk
				addMsg(callOk and (msg or (fileOk and "ok" or "Failed: " .. tostring(file and file.path or "?"))) or ("Failed: " .. tostring(file and file.path or "?")))
			end
			ChangeHistoryService:SetWaypoint("ROTEX ApplyFiles Done")

		elseif action.type == "create_model" then
			local ok2, msg = pcall(handleCreateModel, action)
			success = ok2; addMsg(msg or ok2)

		elseif action.type == "set_property" then
			local ok2, msg = handleSetProperty(action)
			success = ok2; addMsg(msg or ok2)

		elseif action.type == "delete_instance" then
			local ok2, msg = handleDeleteInstance(action)
			success = ok2; addMsg(msg or ok2)

		elseif action.type == "select_instances" then
			local ok2, msg = handleSelectInstances(action)
			success = ok2; addMsg(msg or ok2)

		elseif action.type == "send_context" then
			task.spawn(function()
				local ctx = buildGameContext(true)
				postJSON(HTTP_PORT, "/ai/start", HttpService:JSONEncode(ctx), 8)
				appendLog("[Context] Sent " .. #(ctx.scripts or {}) .. " scripts")
			end)
			continue
		else
			continue
		end

		appendLog("[Studio] " .. table.concat(msgs, "\n[Studio] "))
		postJSON(HTTP_PORT, "/studio/result", HttpService:JSONEncode({ ok = success, messages = msgs }), 4)
	end
end)

-- ── Heartbeat (every 3s) ──────────────────────────────────────────────────────
task.spawn(function()
	while true do
		task.wait(3)
		if not connected then continue end
		local r = postJSON(HTTP_PORT, "/heartbeat", "{}", 4)
		if not r then
			-- heartbeat failed — don't disconnect immediately, server will timeout us
		end
	end
end)

-- ── Startup ───────────────────────────────────────────────────────────────────
setActionButtons(false)
task.delay(3, function() doConnect(false) end)
