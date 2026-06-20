-- ROTEX Studio Plugin v2.0
-- Connects Roblox Studio to the ROTEX AI desktop app.
-- Install: place this file in %LOCALAPPDATA%\Roblox\Plugins\ROTEX.lua

local PORTS = {7878, 7874, 7871, 7870, 7861, 7865, 7822, 7854, 7813, 7816, 7898, 7875}
local HTTP_PORT = PORTS[1]
local BASE_URL  = "http://127.0.0.1:" .. HTTP_PORT

local HttpService           = game:GetService("HttpService")
local Selection             = game:GetService("Selection")
local ChangeHistoryService  = game:GetService("ChangeHistoryService")

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

local function TextInput(parent, placeholder, size, pos)
    local box = Instance.new("TextBox")
    box.Size, box.Position = size, pos
    box.BackgroundColor3, box.TextColor3, box.PlaceholderColor3 = C.panel, C.text, C.quiet
    box.PlaceholderText, box.TextSize, box.Font = placeholder, 13, Enum.Font.Code
    box.Text, box.ClearTextOnFocus, box.BorderSizePixel = "", false, 0
    box.Parent = parent
    Instance.new("UICorner", box).CornerRadius = UDim.new(0, 8)
    return box
end

-- ── Build widget UI ───────────────────────────────────────────────────────────
local root = Frame(widget, UDim2.new(1,0,1,0), UDim2.new(0,0,0,0), C.bg)

-- Header
local hdr = Frame(root, UDim2.new(1,0,0,48), UDim2.new(0,0,0,0), C.surface)
local hdrTitle = Label(hdr, "ROTEX AI", UDim2.new(1,-14,0,20), UDim2.new(0,12,0,8), C.text, 14, true)
Label(hdr, "Studio Bridge v2.0", UDim2.new(1,-14,0,14), UDim2.new(0,12,0,28), C.muted, 9, false)
Frame(root, UDim2.new(1,0,0,1), UDim2.new(0,0,0,48), C.border)

local Y = 58

-- Token
Label(root, "ROTEX TOKEN", UDim2.new(1,-20,0,14), UDim2.new(0,12,0,Y), C.quiet, 9, true)
Y = Y + 17
local tokenBox = TextInput(root, "Paste token from ROTEX app", UDim2.new(1,-70,0,32), UDim2.new(0,10,0,Y))
tokenBox.Text = plugin:GetSetting("rotex_token") or ""
local connectBtn = Button(root, "Connect", UDim2.new(0,56,0,32), UDim2.new(1,-66,0,Y), C.blue, Color3.new(1,1,1), 10)
Y = Y + 40

-- Status + script count
local statusLbl = Label(root, "● Not connected", UDim2.new(1,-20,0,16), UDim2.new(0,12,0,Y), C.quiet, 11)
Y = Y + 20
local scriptCountLbl = Label(root, "", UDim2.new(1,-20,0,14), UDim2.new(0,12,0,Y), C.muted, 10)
Y = Y + 20

Frame(root, UDim2.new(1,-20,0,1), UDim2.new(0,10,0,Y), C.border)
Y = Y + 10

-- Rojo
local rojoConnBtn  = Button(root, "Rojo Connect",    UDim2.new(0.5,-16,0,30), UDim2.new(0,10,0,Y), C.green, C.yellowDk, 10)
local rojoDiscBtn  = Button(root, "Rojo Disconnect", UDim2.new(0.5,-14,0,30), UDim2.new(0.5,4,0,Y), C.red, Color3.new(1,1,1), 10)
Y = Y + 38

-- Send Context (replaces old Start button)
local sendCtxBtn = Button(root, "Send Context to ROTEX", UDim2.new(1,-20,0,36), UDim2.new(0,10,0,Y), C.yellow, C.yellowDk, 13)
Y = Y + 46

Frame(root, UDim2.new(1,-20,0,1), UDim2.new(0,10,0,Y), C.border)
Y = Y + 10

Label(root, "OUTPUT", UDim2.new(1,-20,0,14), UDim2.new(0,10,0,Y), C.quiet, 9, true)
Y = Y + 17

local outputScroll = Instance.new("ScrollingFrame")
outputScroll.Size             = UDim2.new(1,-20,1,-(Y+10))
outputScroll.Position         = UDim2.new(0,10,0,Y)
outputScroll.BackgroundColor3 = C.panel
outputScroll.BorderSizePixel  = 0
outputScroll.ScrollBarThickness   = 4
outputScroll.ScrollBarImageColor3 = C.border
outputScroll.AutomaticCanvasSize  = Enum.AutomaticSize.Y
outputScroll.CanvasSize           = UDim2.new(0,0,0,0)
outputScroll.Parent = root
Instance.new("UICorner", outputScroll).CornerRadius = UDim.new(0, 8)

local outputText = Instance.new("TextBox")
outputText.Size               = UDim2.new(1,-10,0,0)
outputText.Position           = UDim2.new(0,5,0,5)
outputText.BackgroundColor3   = C.panel
outputText.BackgroundTransparency = 0
outputText.BorderSizePixel    = 0
outputText.Text, outputText.TextColor3  = "", C.muted
outputText.TextSize, outputText.Font    = 10, Enum.Font.Code
outputText.TextXAlignment = Enum.TextXAlignment.Left
outputText.TextYAlignment = Enum.TextYAlignment.Top
outputText.TextWrapped, outputText.MultiLine       = true, true
outputText.ClearTextOnFocus, outputText.TextEditable = false, true
outputText.Active, outputText.Selectable             = true, true
outputText.AutomaticSize = Enum.AutomaticSize.Y
outputText.Parent = outputScroll

-- ── State ────────────────────────────────────────────────────────────────────
local connected    = false
local currentToken = tokenBox.Text
local projectName  = ""

local function setStatus(text, color)
    statusLbl.Text, statusLbl.TextColor3 = text, color or C.quiet
end

local function setActionButtons(enabled)
    local a = enabled and 0 or 0.45
    rojoConnBtn.BackgroundTransparency = a; rojoConnBtn.Active = enabled
    rojoDiscBtn.BackgroundTransparency = a; rojoDiscBtn.Active = enabled
    sendCtxBtn.BackgroundTransparency  = a; sendCtxBtn.Active  = enabled
end

local function appendLog(text)
    local prev = outputText.Text
    local combined = (prev == "" and text or (prev .. "\n" .. text))
    outputText.Text = string.sub(combined, -4000)
    task.defer(function()
        outputScroll.CanvasPosition = Vector2.new(0, outputScroll.AbsoluteCanvasSize.Y)
    end)
end

-- ── HTTP helpers ──────────────────────────────────────────────────────────────
local function requestOnPort(method, path, port, body)
    local token = currentToken:match("^%s*(.-)%s*$")
    local ok, result = pcall(function()
        return HttpService:RequestAsync({
            Url     = "http://127.0.0.1:" .. port .. path .. "?token=" .. token,
            Method  = method,
            Headers = { ["Content-Type"] = "application/json" },
            Body    = body or "",
        })
    end)
    return ok and result or nil
end

local function request(method, path, body)
    return requestOnPort(method, path, HTTP_PORT, body)
end

local function findRotex(method, path)
    for _, port in ipairs(PORTS) do
        local res = requestOnPort(method, path, port)
        if res and res.StatusCode == 200 then
            HTTP_PORT = port
            BASE_URL  = "http://127.0.0.1:" .. port
            return res
        end
    end
    return nil
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
                    path   = obj:GetFullName(),
                    name   = obj.Name,
                    class  = obj.ClassName,
                    source = string.sub(obj.Source or "", 1, 5000),
                })
            elseif obj:IsA("BasePart") or obj:IsA("Model") then
                table.insert(selected, {
                    path  = obj:GetFullName(),
                    name  = obj.Name,
                    class = obj.ClassName,
                })
            end
        end
    end
    return { project = projectName, scripts = scripts, selected = selected }
end

local function sendContext(ctx)
    local token = currentToken:match("^%s*(.-)%s*$")
    pcall(function()
        HttpService:RequestAsync({
            Url     = BASE_URL .. "/ai/start?token=" .. token,
            Method  = "POST",
            Headers = { ["Content-Type"] = "application/json" },
            Body    = HttpService:JSONEncode(ctx),
        })
    end)
end

-- ── Instance resolver by full path ───────────────────────────────────────────
local function resolveByPath(fullPath)
    local parts = {}
    for part in string.gmatch(fullPath or "", "[^%.]+") do
        table.insert(parts, part)
    end
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

-- ── Script apply (file blocks) ────────────────────────────────────────────────
local function splitPath(pathText)
    local parts = {}
    for part in string.gmatch(pathText or "", "[^/\\]+") do table.insert(parts, part) end
    return parts
end

local function studioRoot(name)
    local ok, svc = pcall(function() return game:GetService(name) end)
    return (ok and svc) or workspace
end

local function scriptClassFor(name, source)
    local lower = string.lower(name or "")
    if string.find(lower, "localscript") or string.find(lower, "%.client%.lua$") then return "LocalScript" end
    if string.find(lower, "modulescript") or string.find(lower, "%.module%.lua$")
        or string.find(source or "", "[\r\n]%s*return%s+[%w_%.]+%s*$") then return "ModuleScript" end
    return "Script"
end

local function cleanScriptName(name)
    return (name or "ROTEXScript")
        :gsub("%.client%.lua$",""):gsub("%.server%.lua$","")
        :gsub("%.module%.lua$",""):gsub("%.lua$","")
end

local function applyStudioFile(file)
    local parts = splitPath(file.path)
    if #parts < 2 then return false, "Bad path: " .. tostring(file.path) end
    local parent = studioRoot(parts[1])
    for i = 2, #parts - 1 do
        local folder = parent:FindFirstChild(parts[i])
        if not folder then
            folder = Instance.new("Folder")
            folder.Name = parts[i]
            folder.Parent = parent
        end
        parent = folder
    end
    local scriptName = cleanScriptName(parts[#parts])
    local source = file.content or ""
    local existing = parent:FindFirstChild(scriptName)
    if existing and existing:IsA("LuaSourceContainer") then
        existing.Source = source
        return true, "Updated " .. file.path
    end
    local obj = Instance.new(scriptClassFor(parts[#parts], source))
    obj.Name = scriptName
    obj.Source = source
    obj.Parent = parent
    return true, "Created " .. file.path
end

-- ── Model creation ────────────────────────────────────────────────────────────
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
    model.Name = action.name or "ROTEXModel"
    model.Parent = parentInst

    local msgs = {"Created model: " .. model.Name}

    for _, pd in ipairs(action.parts or {}) do
        local partClass = pd.class or "Part"
        local part = Instance.new(partClass)
        part.Name = pd.name or "Part"

        if pd.size then
            part.Size = Vector3.new(pd.size[1] or 4, pd.size[2] or 4, pd.size[3] or 4)
        end
        if pd.position then
            part.CFrame = CFrame.new(pd.position[1] or 0, pd.position[2] or 5, pd.position[3] or 0)
        end
        if pd.rotation and pd.position then
            part.CFrame = CFrame.new(pd.position[1] or 0, pd.position[2] or 5, pd.position[3] or 0)
                * CFrame.Angles(math.rad(pd.rotation[1] or 0), math.rad(pd.rotation[2] or 0), math.rad(pd.rotation[3] or 0))
        end
        if pd.color then
            if type(pd.color) == "table" then
                part.Color = Color3.fromRGB(pd.color[1] or 128, pd.color[2] or 128, pd.color[3] or 128)
            else
                local ok2, bc = pcall(function() return BrickColor.new(tostring(pd.color)) end)
                if ok2 then part.BrickColor = bc end
            end
        end
        if pd.material and part:IsA("BasePart") then
            local ok2, mat = pcall(function() return Enum.Material[pd.material] end)
            if ok2 then part.Material = mat end
        end
        if pd.shape and part:IsA("Part") then
            local ok2, sh = pcall(function() return Enum.PartType[pd.shape] end)
            if ok2 then part.Shape = sh end
        end
        if part:IsA("BasePart") then
            part.Anchored   = (pd.anchored ~= false)
            part.CanCollide = (pd.cancollide ~= false)
            if pd.transparency ~= nil then part.Transparency = pd.transparency end
            if pd.castShadow  ~= nil then part.CastShadow   = pd.castShadow  end
        end

        -- Child scripts on parts
        for _, sc in ipairs(pd.scripts or {}) do
            local s = Instance.new(scriptClassFor(sc.name or "Script", sc.source or ""))
            s.Name   = cleanScriptName(sc.name or "Script")
            s.Source = sc.source or ""
            s.Parent = part
        end

        part.Parent = model
        table.insert(msgs, "  + " .. part.Name .. " (" .. partClass .. ")")
    end

    -- Top-level scripts on model
    for _, sc in ipairs(action.scripts or {}) do
        local s = Instance.new(scriptClassFor(sc.name or "Script", sc.source or ""))
        s.Name   = cleanScriptName(sc.name or "Script")
        s.Source = sc.source or ""
        s.Parent = model
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

-- ── Result reporter ───────────────────────────────────────────────────────────
local function reportResult(result)
    local token = currentToken:match("^%s*(.-)%s*$")
    pcall(function()
        HttpService:RequestAsync({
            Url     = BASE_URL .. "/studio/result?token=" .. token,
            Method  = "POST",
            Headers = { ["Content-Type"] = "application/json" },
            Body    = HttpService:JSONEncode(result),
        })
    end)
end

-- ── Action poll loop ──────────────────────────────────────────────────────────
local function pollStudioActions()
    if not connected then return end
    local res = request("GET", "/studio/actions")
    if not (res and res.StatusCode == 200) then return end
    local ok, data = pcall(function() return HttpService:JSONDecode(res.Body) end)
    if not ok or not data or not data.action then return end

    local action  = data.action
    local msgs    = {}
    local success = true

    if action.type == "apply_files" and type(action.files) == "table" then
        ChangeHistoryService:SetWaypoint("ROTEX ApplyFiles")
        for _, file in ipairs(action.files) do
            local ok2, msg = pcall(applyStudioFile, file)
            table.insert(msgs, ok2 and (msg or "ok") or ("Failed: " .. tostring(file and file.path or "?")))
        end
        ChangeHistoryService:SetWaypoint("ROTEX ApplyFiles Done")

    elseif action.type == "create_model" then
        local ok2, msg = pcall(handleCreateModel, action)
        success = ok2; table.insert(msgs, msg or tostring(ok2))

    elseif action.type == "set_property" then
        local ok2, msg = handleSetProperty(action)
        success = ok2; table.insert(msgs, msg)

    elseif action.type == "delete_instance" then
        local ok2, msg = handleDeleteInstance(action)
        success = ok2; table.insert(msgs, msg)

    elseif action.type == "select_instances" then
        local ok2, msg = handleSelectInstances(action)
        success = ok2; table.insert(msgs, msg)

    elseif action.type == "send_context" then
        task.spawn(function()
            local ctx = buildGameContext(true)
            sendContext(ctx)
            appendLog("[Context] Sent " .. #(ctx.scripts or {}) .. " scripts")
        end)
        return

    else
        return
    end

    appendLog("[Studio] " .. table.concat(msgs, "\n[Studio] "))
    reportResult({ ok = success, messages = msgs })
end

-- ── Connect handler ───────────────────────────────────────────────────────────
local function doConnect()
    local token = tokenBox.Text:match("^%s*(.-)%s*$")
    if #token < 4 then setStatus("● Enter a valid token", C.red) return end
    currentToken = token
    setStatus("● Connecting…", C.yellow)
    scriptCountLbl.Text = ""

    local res = findRotex("GET", "/ping")
    if res and res.StatusCode == 200 then
        local ok2, data = pcall(function() return HttpService:JSONDecode(res.Body) end)
        if ok2 and data and data.ok then
            connected   = true
            projectName = data.project or ""
            plugin:SetSetting("rotex_token", token)
            setActionButtons(true)
            connectBtn.Text = "Reconnect"
            setStatus("● Connected — " .. (projectName ~= "" and projectName or "ROTEX"), C.green)
            appendLog("[ROTEX] Connected" .. (projectName ~= "" and (" — " .. projectName) or ""))

            -- Auto-scan and send full game context on connection
            task.spawn(function()
                appendLog("[Scan] Reading game scripts…")
                local ctx = buildGameContext(false)
                local n = #(ctx.scripts or {})
                scriptCountLbl.Text = n .. " scripts found"
                sendContext(ctx)
                appendLog("[Scan] Sent " .. n .. " scripts to ROTEX — ready to chat!")
            end)
        else
            setStatus("● Wrong token", C.red)
        end
    else
        setStatus("● ROTEX not running — open the desktop app", C.red)
    end
end

connectBtn.MouseButton1Click:Connect(doConnect)
tokenBox.FocusLost:Connect(function(enter) if enter then doConnect() end end)

-- ── Rojo ──────────────────────────────────────────────────────────────────────
rojoConnBtn.MouseButton1Click:Connect(function()
    if not connected then return end
    local res = request("POST", "/rojo/start")
    if res and res.StatusCode == 200 then
        appendLog("[Rojo] Server started — sync in Studio")
        setStatus("● Connected · Rojo running", C.green)
    else
        appendLog("[Rojo] Failed — is rojo installed? (rojo.space)")
    end
end)

rojoDiscBtn.MouseButton1Click:Connect(function()
    if not connected then return end
    local res = request("POST", "/rojo/stop")
    if res and res.StatusCode == 200 then
        appendLog("[Rojo] Server stopped")
        setStatus("● Connected", C.green)
    end
end)

-- ── Send Context button ───────────────────────────────────────────────────────
sendCtxBtn.MouseButton1Click:Connect(function()
    if not connected then return end
    appendLog("[Context] Scanning game…")
    task.spawn(function()
        local ctx = buildGameContext(true)
        local n = #(ctx.scripts or {})
        local s = #(ctx.selected or {})
        scriptCountLbl.Text = n .. " scripts · " .. s .. " selected"
        sendContext(ctx)
        appendLog("[Context] Sent " .. n .. " scripts" .. (s > 0 and (", " .. s .. " selected") or "") .. " to ROTEX")
    end)
end)

-- ── Toolbar toggle ────────────────────────────────────────────────────────────
btnOpen.Click:Connect(function()
    widget.Enabled = not widget.Enabled
end)

-- ── Startup ───────────────────────────────────────────────────────────────────
setActionButtons(false)

task.spawn(function()
    while true do
        task.wait(1)
        pcall(pollStudioActions)
    end
end)

if #(plugin:GetSetting("rotex_token") or "") >= 4 then
    task.delay(1, doConnect)
end
