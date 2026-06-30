-- ROTEX Studio Plugin v2.5
-- Connects Roblox Studio to the ROTEX AI desktop app.

local PORTS = {7878, 7874, 7871, 7870, 7861}
local HTTP_PORT = PORTS[1]

local HttpService          = game:GetService("HttpService")
local Selection            = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Lighting             = game:GetService("Lighting")
local Terrain              = workspace.Terrain

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
Label(hdr, "Studio Bridge v2.5", UDim2.new(1,-14,0,14), UDim2.new(0,12,0,28), C.muted, 9, false)
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

-- Scripts now auto-sync every 10s while connected — no manual "Send Context" button.

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

local function setStatus(text, color)
	statusLbl.Text, statusLbl.TextColor3 = text, color or C.quiet
end

local function setActionButtons(enabled)
	local a = enabled and 0 or 0.45
	disconnectBtn.BackgroundTransparency = a; disconnectBtn.Active = enabled
end

local function appendLog(text)
	local prev = outputText.Text
	outputText.Text = string.sub((prev == "" and text or (prev .. "\n" .. text)), -4000)
	task.defer(function()
		outputScroll.CanvasPosition = Vector2.new(0, outputScroll.AbsoluteCanvasSize.Y)
	end)
end

-- ── HTTP: GET with timeout ────────────────────────────────────────────────────
local function getJSON(port, path, timeoutSecs)
	local token = currentToken:match("^%s*(.-)%s*$")
	local url   = "http://127.0.0.1:" .. port .. path .. "?token=" .. token
	local ref   = {done = false, data = nil, err = nil}
	task.spawn(function()
		local ok, res = pcall(function()
			return HttpService:RequestAsync({
				Url     = url,
				Method  = "GET",
				Headers = {},
			})
		end)
		if ok and res then
			if res.Success then
				local ok2, decoded = pcall(function() return HttpService:JSONDecode(res.Body or "") end)
				ref.data = ok2 and decoded or nil
				if not ok2 then ref.err = "bad JSON: " .. tostring(res.Body) end
				if ok2 and type(decoded) == "table" and decoded.token and decoded.token ~= "" then
					currentToken = tostring(decoded.token)
					plugin:SetSetting("rotex_token", currentToken)
				end
			else
				ref.err = "HTTP " .. tostring(res.StatusCode) .. " " .. tostring(res.StatusMessage)
			end
		else
			ref.err = tostring(res)
		end
		ref.done = true
	end)
	local t0 = tick()
	while not ref.done and (tick() - t0) < (timeoutSecs or 5) do task.wait(0.1) end
	return ref.data, ref.err
end

-- ── HTTP: POST with timeout ───────────────────────────────────────────────────
local function postJSON(port, path, body, timeoutSecs)
	local ref   = {done = false, data = nil}
	task.spawn(function()
		for attempt = 1, 2 do
			local token = currentToken:match("^%s*(.-)%s*$")
			local url   = "http://127.0.0.1:" .. port .. path .. "?token=" .. token
			local ok, res = pcall(function()
				return HttpService:RequestAsync({
					Url     = url,
					Method  = "POST",
					Headers = { ["Content-Type"] = "application/json" },
					Body    = body or "{}",
				})
			end)
			if ok and res then
				local ok2, decoded = pcall(function() return HttpService:JSONDecode(res.Body or "{}") end)
				if ok2 and type(decoded) == "table" and decoded.token and decoded.token ~= "" then
					currentToken = tostring(decoded.token)
					plugin:SetSetting("rotex_token", currentToken)
				end
				if res.StatusCode >= 200 and res.StatusCode < 300 then
					ref.data = ok2 and decoded or { ok = true }
					break
				end
				if res.StatusCode ~= 401 then break end
			else
				break
			end
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
	local gameName = projectName
	if not gameName or gameName == "" then
		local ok, n = pcall(function() return game.Name end)
		gameName = (ok and n and n ~= "" and n) or "Untitled Experience"
	end
	return {
		project = projectName,
		gameName = gameName,
		pluginVersion = "2.5",
		capabilities = {
			"apply_files",
			"create_model geometry",
			"terrain_edit fill_block/fill_ball/clear",
			"lighting_set properties",
			"create_ui_image ImageLabel/ImageButton",
			"set_property parts/instances",
			"delete_instance",
			"select_instances",
		},
		scripts = scripts,
		selected = selected,
	}
end

-- ── Instance resolver ─────────────────────────────────────────────────────────
local function resolveByPath(fullPath)
	local parts = {}
	for part in string.gmatch((fullPath or ""):gsub("[/\\]", "."), "[^%.]+") do table.insert(parts, part) end
	if #parts == 0 then return nil end
	if parts[1] == "StarterPlayerScripts" or parts[1] == "StarterCharacterScripts" then
		table.insert(parts, 1, "StarterPlayer")
	end
	if parts[#parts] then
		parts[#parts] = (parts[#parts] or "")
			:gsub("%.client%.lua$","")
			:gsub("%.server%.lua$","")
			:gsub("%.module%.lua$","")
			:gsub("%.lua$","")
	end
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
	local action = "Created"
	local existing = parent:FindFirstChild(scriptName)
	local existingClass = nil
	if existing and existing:IsA("LuaSourceContainer") then
		existingClass = existing.ClassName
		existing:Destroy()
		action = "Updated"
	end
	local obj = Instance.new(existingClass or scriptClassFor(parts[#parts], source))
	obj.Name, obj.Source, obj.Parent = scriptName, source, parent
	return true, action .. " " .. file.path
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

local function vectorFromTable(value, default)
	if type(value) ~= "table" then return default end
	return Vector3.new(value[1] or default.X, value[2] or default.Y, value[3] or default.Z)
end

local function vector2FromTable(value, default)
	if type(value) ~= "table" then return default end
	return Vector2.new(value[1] or default.X, value[2] or default.Y)
end

local function udim2FromTable(value, default)
	if type(value) ~= "table" then return default end
	return UDim2.new(value[1] or 0, value[2] or 0, value[3] or 0, value[4] or 0)
end

local function colorFromValue(value)
	if typeof(value) == "Color3" then return value end
	if type(value) == "table" then
		return Color3.fromRGB(value[1] or 255, value[2] or 255, value[3] or 255)
	end
	if type(value) == "string" then
		local ok, brick = pcall(function() return BrickColor.new(value) end)
		if ok then return brick.Color end
	end
	return nil
end

local function materialFromValue(value, fallback)
	if not value then return fallback end
	local ok, material = pcall(function() return Enum.Material[tostring(value)] end)
	return (ok and material) or fallback
end

local function handleTerrainEdit(action)
	ChangeHistoryService:SetWaypoint("ROTEX TerrainEdit")
	local operation = string.lower(tostring(action.operation or action.mode or "fill_block"))
	local material = operation == "clear" and Enum.Material.Air or materialFromValue(action.material, Enum.Material.Grass)
	local position = vectorFromTable(action.position, Vector3.new(0, 0, 0))
	local size = vectorFromTable(action.size, Vector3.new(32, 16, 32))
	local radius = tonumber(action.radius) or math.max(size.X, size.Y, size.Z) / 2
	if operation == "fill_ball" or operation == "ball" then
		Terrain:FillBall(position, radius, material)
		ChangeHistoryService:SetWaypoint("ROTEX TerrainEdit Done")
		return true, "Edited terrain: fill_ball " .. tostring(material.Name)
	end
	local cf = CFrame.new(position)
	if type(action.rotation) == "table" then
		cf = cf * CFrame.Angles(math.rad(action.rotation[1] or 0), math.rad(action.rotation[2] or 0), math.rad(action.rotation[3] or 0))
	end
	Terrain:FillBlock(cf, size, material)
	ChangeHistoryService:SetWaypoint("ROTEX TerrainEdit Done")
	return true, "Edited terrain: " .. operation .. " " .. tostring(material.Name)
end

local function handleLightingSet(action)
	ChangeHistoryService:SetWaypoint("ROTEX LightingSet")
	local props = action.properties
	if type(props) ~= "table" then
		props = {}
		if action.property then props[action.property] = action.value end
	end
	local changed = {}
	for prop, value in pairs(props) do
		local finalValue = value
		local lower = string.lower(tostring(prop))
		if lower:find("color") or lower == "ambient" or lower == "outdoorambient" then
			finalValue = colorFromValue(value) or value
		end
		local ok, err = pcall(function() Lighting[prop] = finalValue end)
		if ok then
			table.insert(changed, tostring(prop))
		else
			table.insert(changed, tostring(prop) .. " failed: " .. tostring(err))
		end
	end
	ChangeHistoryService:SetWaypoint("ROTEX LightingSet Done")
	return true, "Updated lighting: " .. table.concat(changed, ", ")
end

local function handleCreateUiImage(action)
	ChangeHistoryService:SetWaypoint("ROTEX CreateUIImage")
	local parent = resolveByPath(action.parent or "StarterGui") or game:GetService("StarterGui")
	local screenGui = parent
	if not screenGui:IsA("ScreenGui") then
		local guiName = tostring(action.screenGui or "ROTEXGui")
		screenGui = parent:FindFirstChild(guiName)
		if not screenGui or not screenGui:IsA("ScreenGui") then
			screenGui = Instance.new("ScreenGui")
			screenGui.Name = guiName
			screenGui.ResetOnSpawn = false
			screenGui.IgnoreGuiInset = true
			screenGui.Parent = parent
		end
	end
	local className = action.className == "ImageButton" and "ImageButton" or "ImageLabel"
	local image = Instance.new(className)
	image.Name = tostring(action.name or "ROTEXImage")
	local imageValue = tostring(action.image or action.assetId or "")
	if imageValue ~= "" and not imageValue:match("^rbxassetid://") and imageValue:match("^%d+$") then
		imageValue = "rbxassetid://" .. imageValue
	end
	image.Image = imageValue
	image.BackgroundTransparency = action.backgroundTransparency ~= nil and action.backgroundTransparency or 1
	image.ImageTransparency = action.imageTransparency or 0
	image.AnchorPoint = vector2FromTable(action.anchorPoint, Vector2.new(0, 0))
	image.Position = udim2FromTable(action.position, UDim2.new(0, 16, 0, 16))
	image.Size = udim2FromTable(action.size, UDim2.new(0, 48, 0, 48))
	image.ScaleType = Enum.ScaleType.Fit
	image.Parent = screenGui
	ChangeHistoryService:SetWaypoint("ROTEX CreateUIImage Done")
	return true, "Created UI image: " .. screenGui.Name .. "/" .. image.Name
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

-- ── Connection helpers ────────────────────────────────────────────────────────
-- Detects the "Http requests are not enabled" Studio error so we can tell the
-- user exactly how to fix it instead of silently showing "not found".
local function isHttpDisabled(err)
	if not err then return false end
	local e = string.lower(tostring(err))
	return e:find("not enabled", 1, true) ~= nil
		or e:find("http requests", 1, true) ~= nil
		or e:find("httpenabled", 1, true) ~= nil
end

local function tryConnect()
	local lastErr = nil
	for _, port in ipairs(PORTS) do
		local data, err = getJSON(port, "/ping", 2)
		if data and data.ok then return port, data end
		if err then
			lastErr = err
			appendLog("[ROTEX] port " .. port .. " → " .. err)
		end
	end
	return nil, nil, lastErr
end

local function onConnected(connPort, connData)
	HTTP_PORT   = connPort
	local token = (connData.token or ""):match("^%s*(.-)%s*$")
	if #token >= 4 then
		currentToken = token
		plugin:SetSetting("rotex_token", token)
	end
	connected   = true
	projectName = connData.project or ""
	setActionButtons(true)
	connectBtn.Text = "Reconnect"
	setStatus("✓ Connected · port " .. connPort, C.green)
	appendLog("[ROTEX] Connected on port " .. connPort)
	task.spawn(function()
		appendLog("[Scan] Reading game scripts…")
		local ctx = buildGameContext(false)
		local n   = #(ctx.scripts or {})
		scriptCountLbl.Text = n .. " scripts found"
		postJSON(HTTP_PORT, "/ai/start", HttpService:JSONEncode(ctx), 8)
		appendLog("[Scan] Sent " .. n .. " scripts — ready to chat!")
	end)
end

local function onDisconnected(reason)
	connected = false
	setActionButtons(false)
	connectBtn.Text = "Connect to ROTEX"
	setStatus("● " .. (reason or "Disconnected"), C.quiet)
	scriptCountLbl.Text = ""
end

-- ── Auto-connect loop (runs forever, retries every 5 s when not connected) ───
task.spawn(function()
	while true do
		if not connected then
			setStatus("● Searching for ROTEX Desktop…", C.yellow)
			local connPort, connData, connErr = tryConnect()
			if connPort then
				onConnected(connPort, connData)
			elseif isHttpDisabled(connErr) then
				setStatus("⚠ Enable HTTP Requests (see log)", C.red)
				connectBtn.Text = "Connect to ROTEX"
				appendLog("[ROTEX] HTTP requests are OFF. Fix: Home → Game Settings → Security → turn ON 'Allow HTTP Requests' (or run  game:GetService('HttpService').HttpEnabled = true  in the command bar), then click Connect.")
			else
				setStatus("● ROTEX Desktop not found — is the app open?", C.quiet)
				connectBtn.Text = "Connect to ROTEX"
			end
		end
		task.wait(5)
	end
end)

-- ── Disconnect button (manual stop) ──────────────────────────────────────────
disconnectBtn.MouseButton1Click:Connect(function()
	if not connected then return end
	postJSON(HTTP_PORT, "/disconnect", "{}", 2)
	onDisconnected("Manually disconnected")
	appendLog("[ROTEX] Manually disconnected")
end)

-- ── Auto-send game context every 10s while connected ──────────────────────────
-- Replaces the old manual "Send Context" button. Keeps ROTEX's view of the
-- place's scripts fresh automatically.
task.spawn(function()
	while true do
		task.wait(10)
		if not connected then continue end
		local ok, ctx = pcall(function() return buildGameContext(false) end)
		if ok and ctx then
			local n = #(ctx.scripts or {})
			scriptCountLbl.Text = n .. " scripts found"
			postJSON(HTTP_PORT, "/ai/start", HttpService:JSONEncode(ctx), 8)
		end
	end
end)

-- ── Connect button (force immediate retry) ────────────────────────────────────
connectBtn.MouseButton1Click:Connect(function()
	if connected then return end
	setStatus("● Connecting…", C.yellow)
	connectBtn.Text = "Connecting…"
	appendLog("[ROTEX] Connecting…")
	task.spawn(function()
		local connPort, connData, connErr = tryConnect()
		if connPort then
			onConnected(connPort, connData)
		elseif isHttpDisabled(connErr) then
			connectBtn.Text = "Connect to ROTEX"
			setStatus("⚠ Enable HTTP Requests (see log)", C.red)
			appendLog("[ROTEX] HTTP requests are OFF. Fix: Home → Game Settings → Security → turn ON 'Allow HTTP Requests' (or run  game:GetService('HttpService').HttpEnabled = true  in the command bar), then click Connect.")
		else
			connectBtn.Text = "Connect to ROTEX"
			setStatus("● ROTEX Desktop not found", C.quiet)
			appendLog("[ROTEX] Could not reach ROTEX — is the desktop app open?")
		end
	end)
end)

-- ── Toolbar toggle ────────────────────────────────────────────────────────────
btnOpen.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

-- ── Action poll loop (1 s) — also detects disconnect via consecutive failures ─
task.spawn(function()
	local failCount = 0
	while true do
		task.wait(1)
		if not connected then failCount = 0; continue end
		local data = getJSON(HTTP_PORT, "/studio/actions", 4)
		if not data then
			failCount = failCount + 1
			if failCount >= 5 then
				appendLog("[ROTEX] Connection lost — reconnecting automatically…")
				onDisconnected("Lost connection — reconnecting…")
				failCount = 0
			end
			continue
		end
		failCount = 0
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

		elseif action.type == "terrain_edit" then
			local ok2, msg = pcall(handleTerrainEdit, action)
			success = ok2; addMsg(msg or ok2)

		elseif action.type == "lighting_set" then
			local ok2, msg = pcall(handleLightingSet, action)
			success = ok2; addMsg(msg or ok2)

		elseif action.type == "create_ui_image" then
			local ok2, msg = pcall(handleCreateUiImage, action)
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
		postJSON(HTTP_PORT, "/studio/result", HttpService:JSONEncode({ ok = success, messages = msgs, actionId = action.id }), 4)
	end
end)

-- ── Error capture ─────────────────────────────────────────────────────────────
local LogService = game:GetService("LogService")
local lastErrorAt = 0
local ERROR_THROTTLE_SEC = 2
local errorConnection = LogService.MessageOut:Connect(function(message, messageType)
	if not connected then return end
	if messageType ~= Enum.MessageType.MessageError and messageType ~= Enum.MessageType.MessageWarning then return end
	-- Throttle identical errors to avoid spamming the AI.
	local now = tick()
	if now - lastErrorAt < ERROR_THROTTLE_SEC then return end
	lastErrorAt = now
	local payload = HttpService:JSONEncode({
		message = tostring(message),
		type = tostring(messageType),
		time = os.time(),
	})
	postJSON(HTTP_PORT, "/studio/error", payload, 4)
end)

-- ── Heartbeat (every 0.7s) ────────────────────────────────────────────────────
task.spawn(function()
	while true do
		task.wait(0.7)
		if not connected then continue end
		local r = postJSON(HTTP_PORT, "/heartbeat", "{}", 4)
		if not r then
			-- heartbeat failed — don't disconnect immediately, server will timeout us
		end
	end
end)

-- ── Startup ───────────────────────────────────────────────────────────────────
setActionButtons(false)
