-- ROTEX Studio Plugin
-- Connects Roblox Studio to the ROTEX AI desktop app.
-- Install: place this file in %LOCALAPPDATA%\Roblox\Plugins\ROTEX.lua

local PORTS = {7878, 7874, 7871, 7870, 7861, 7865, 7822, 7854, 7813, 7816, 7898, 7875}
local HTTP_PORT = PORTS[1]
local BASE_URL  = "http://127.0.0.1:" .. HTTP_PORT

local HttpService  = game:GetService("HttpService")
local Selection    = game:GetService("Selection")
local RunService   = game:GetService("RunService")

-- ── Toolbar buttons ──────────────────────────────────────────────────────────
local toolbar = plugin:CreateToolbar("ROTEX AI")

local btnOpen = toolbar:CreateButton(
    "Open", "Open the ROTEX AI panel", "rbxassetid://0"
)

-- ── Dock widget ──────────────────────────────────────────────────────────────
local widgetInfo = DockWidgetPluginGuiInfo.new(
    Enum.InitialDockState.Right,
    false, false,
    280, 480,
    220, 360
)
local widget = plugin:CreateDockWidgetPluginGui("ROTEX_Panel", widgetInfo)
widget.Title = "ROTEX AI"
widget.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

-- ── Color palette ────────────────────────────────────────────────────────────
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

-- ── Helper: create rounded frame ─────────────────────────────────────────────
local function Frame(parent, size, pos, bg, radius)
    local f = Instance.new("Frame")
    f.Size              = size
    f.Position          = pos
    f.BackgroundColor3  = bg or C.panel
    f.BorderSizePixel   = 0
    f.Parent            = parent
    if radius then
        local c = Instance.new("UICorner")
        c.CornerRadius = UDim.new(0, radius)
        c.Parent = f
    end
    return f
end

local function Label(parent, text, size, pos, color, fs, bold, wrap)
    local l = Instance.new("TextLabel")
    l.Size               = size
    l.Position           = pos
    l.BackgroundTransparency = 1
    l.Text               = text
    l.TextColor3         = color or C.text
    l.TextSize           = fs or 12
    l.Font               = bold and Enum.Font.GothamBold or Enum.Font.Gotham
    l.TextXAlignment     = Enum.TextXAlignment.Left
    l.TextYAlignment     = Enum.TextYAlignment.Top
    l.TextWrapped        = wrap or false
    l.Parent             = parent
    return l
end

local function Button(parent, text, size, pos, bg, textColor, fs)
    local b = Instance.new("TextButton")
    b.Size              = size
    b.Position          = pos
    b.BackgroundColor3  = bg or C.blue
    b.TextColor3        = textColor or Color3.new(1,1,1)
    b.Text              = text
    b.TextSize          = fs or 11
    b.Font              = Enum.Font.GothamBold
    b.BorderSizePixel   = 0
    b.AutoButtonColor   = true
    b.Parent            = parent
    Instance.new("UICorner", b).CornerRadius = UDim.new(0, 8)
    return b
end

local function TextInput(parent, placeholder, size, pos)
    local box = Instance.new("TextBox")
    box.Size              = size
    box.Position          = pos
    box.BackgroundColor3  = C.panel
    box.TextColor3        = C.text
    box.PlaceholderText   = placeholder
    box.PlaceholderColor3 = C.quiet
    box.TextSize          = 13
    box.Font              = Enum.Font.Code
    box.Text              = ""
    box.ClearTextOnFocus  = false
    box.BorderSizePixel   = 0
    box.Parent            = parent
    Instance.new("UICorner", box).CornerRadius = UDim.new(0, 8)
    return box
end

-- ── Build widget UI ──────────────────────────────────────────────────────────
local root = Frame(widget, UDim2.new(1,0,1,0), UDim2.new(0,0,0,0), C.bg)

-- Header
local hdr = Frame(root, UDim2.new(1,0,0,40), UDim2.new(0,0,0,0), C.surface)
local hdrTitle = Label(hdr, "ROTEX AI", UDim2.new(1,-14,1,0), UDim2.new(0,12,0,0), C.text, 13, true)
hdrTitle.TextYAlignment = Enum.TextYAlignment.Center

-- Divider
Frame(root, UDim2.new(1,0,0,1), UDim2.new(0,0,0,40), C.border)

local Y = 50  -- current vertical offset

-- Token label
Label(root, "Token from ROTEX:", UDim2.new(1,-20,0,16), UDim2.new(0,10,0,Y), C.muted, 10, true)
Y = Y + 18

-- Token input
local tokenBox = TextInput(root, "e.g. A3K9F2", UDim2.new(1,-60,0,30), UDim2.new(0,10,0,Y))
tokenBox.Text = plugin:GetSetting("rotex_token") or ""

-- Connect button
local connectBtn = Button(root, "Connect", UDim2.new(0,44,0,30), UDim2.new(1,-54,0,Y), C.blue, Color3.new(1,1,1), 10)
Y = Y + 38

-- Status label
local statusLbl = Label(root, "● Not connected", UDim2.new(1,-20,0,16), UDim2.new(0,10,0,Y), C.quiet, 11)
Y = Y + 24

-- Divider
Frame(root, UDim2.new(1,-20,0,1), UDim2.new(0,10,0,Y), C.border)
Y = Y + 12

-- Rojo row
local rojoConnBtn    = Button(root, "Rojo Connect", UDim2.new(0.5,-16,0,30), UDim2.new(0,10,0,Y), C.green, C.yellowDk, 10)
local rojoDiscBtn    = Button(root, "Rojo Disconnect", UDim2.new(0.5,-14,0,30), UDim2.new(0.5,4,0,Y), C.red, Color3.new(1,1,1), 10)
Y = Y + 38

-- Start button
local startBtn2 = Button(root, "Start", UDim2.new(1,-20,0,36), UDim2.new(0,10,0,Y), C.yellow, C.yellowDk, 13)
Y = Y + 46

-- Divider
Frame(root, UDim2.new(1,-20,0,1), UDim2.new(0,10,0,Y), C.border)
Y = Y + 10

-- Output section
Label(root, "OUTPUT", UDim2.new(1,-20,0,14), UDim2.new(0,10,0,Y), C.quiet, 9, true)
Y = Y + 17

local outputScroll = Instance.new("ScrollingFrame")
outputScroll.Size                 = UDim2.new(1,-20,1,-(Y+10))
outputScroll.Position             = UDim2.new(0,10,0,Y)
outputScroll.BackgroundColor3     = C.panel
outputScroll.BorderSizePixel      = 0
outputScroll.ScrollBarThickness   = 4
outputScroll.ScrollBarImageColor3 = C.border
outputScroll.AutomaticCanvasSize  = Enum.AutomaticSize.Y
outputScroll.CanvasSize           = UDim2.new(0,0,0,0)
outputScroll.Parent               = root
Instance.new("UICorner", outputScroll).CornerRadius = UDim.new(0, 8)

local outputText = Instance.new("TextBox")
outputText.Size                   = UDim2.new(1,-10,0,0)
outputText.Position               = UDim2.new(0,5,0,5)
outputText.BackgroundColor3       = C.panel
outputText.BackgroundTransparency = 0
outputText.BorderSizePixel        = 0
outputText.Text                   = ""
outputText.TextColor3             = C.muted
outputText.TextSize               = 10
outputText.Font                   = Enum.Font.Code
outputText.TextXAlignment         = Enum.TextXAlignment.Left
outputText.TextYAlignment         = Enum.TextYAlignment.Top
outputText.TextWrapped            = true
outputText.MultiLine              = true
outputText.ClearTextOnFocus       = false
outputText.TextEditable           = true
outputText.Active                 = true
outputText.Selectable             = true
outputText.AutomaticSize          = Enum.AutomaticSize.Y
outputText.Parent                 = outputScroll

-- ── State ────────────────────────────────────────────────────────────────────
local connected    = false
local currentToken = tokenBox.Text
local projectName  = ""
local rojoRunning  = false

local function setStatus(text, color)
    statusLbl.Text       = text
    statusLbl.TextColor3 = color or C.quiet
end

local function setActionButtons(enabled)
    local alpha = enabled and 0 or 0.45
    rojoConnBtn.BackgroundTransparency  = alpha
    rojoDiscBtn.BackgroundTransparency  = alpha
    startBtn2.BackgroundTransparency    = alpha
    rojoConnBtn.Active  = enabled
    rojoDiscBtn.Active  = enabled
    startBtn2.Active    = enabled
end

local function appendLog(text)
    local prev = outputText.Text
    outputText.Text = prev == "" and text or (prev .. "\n" .. text)
    -- scroll to bottom
    task.defer(function()
        outputScroll.CanvasPosition = Vector2.new(0, outputScroll.AbsoluteCanvasSize.Y)
    end)
end

local function clearConnectionErrors()
    local cleaned = {}
    for line in string.gmatch(outputText.Text, "[^\n]+") do
        if not string.find(line, "Could not reach ROTEX", 1, true) then
            table.insert(cleaned, line)
        end
    end
    outputText.Text = table.concat(cleaned, "\n")
end

local function setPort(port)
    HTTP_PORT = port
    BASE_URL = "http://127.0.0.1:" .. HTTP_PORT
end

local function requestOnPort(method, path, port)
    local token = currentToken:match("^%s*(.-)%s*$")
    local ok, result = pcall(function()
        return HttpService:RequestAsync({
            Url     = "http://127.0.0.1:" .. port .. path .. "?token=" .. token,
            Method  = method,
            Headers = { ["Content-Type"] = "application/json" },
        })
    end)
    if ok then return result end
    return nil
end

local function request(method, path)
    return requestOnPort(method, path, HTTP_PORT)
end

local function findRotex(method, path)
    local lastResponse = nil
    for _, port in ipairs(PORTS) do
        local res = requestOnPort(method, path, port)
        if res then
            if res.StatusCode == 200 then
                setPort(port)
                return res
            end
            lastResponse = res
        end
    end
    return lastResponse
end

local function splitPath(pathText)
    local parts = {}
    for part in string.gmatch(pathText or "", "[^/\\]+") do
        table.insert(parts, part)
    end
    return parts
end

local function studioRoot(name)
    local ok, service = pcall(function()
        return game:GetService(name)
    end)
    if ok and service then return service end
    return workspace
end

local function scriptClassFor(name, source)
    local lower = string.lower(name or "")
    if string.find(lower, "localscript") or string.find(lower, "%.client%.lua$") then
        return "LocalScript"
    end
    if string.find(lower, "modulescript") or string.find(lower, "%.module%.lua$") or string.find(source or "", "[\r\n]%s*return%s+[%w_%.]+%s*$") then
        return "ModuleScript"
    end
    return "Script"
end

local function cleanScriptName(name)
    return (name or "ROTEXScript"):gsub("%.client%.lua$", ""):gsub("%.server%.lua$", ""):gsub("%.module%.lua$", ""):gsub("%.lua$", "")
end

local function applyStudioFile(file)
    local parts = splitPath(file.path)
    if #parts < 2 then return false, "Bad path: " .. tostring(file.path) end

    local parent = studioRoot(parts[1])
    for i = 2, #parts - 1 do
        local folderName = parts[i]
        local folder = parent:FindFirstChild(folderName)
        if not folder then
            folder = Instance.new("Folder")
            folder.Name = folderName
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

local function reportStudioResult(result)
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

local function pollStudioActions()
    if not connected then return end
    local res = request("GET", "/studio/actions")
    if not (res and res.StatusCode == 200) then return end
    local ok, data = pcall(function() return HttpService:JSONDecode(res.Body) end)
    if not ok or not data or not data.action then return end

    local action = data.action
    if action.type == "apply_files" and type(action.files) == "table" then
        local messages = {}
        for _, file in ipairs(action.files) do
            local okFile, okApply, msg = pcall(function()
                return applyStudioFile(file)
            end)
            if okFile and okApply then
                table.insert(messages, msg)
            else
                table.insert(messages, "Failed " .. tostring(file and file.path or "file"))
            end
        end
        appendLog("[Studio] " .. table.concat(messages, "\n[Studio] "))
        reportStudioResult({ ok = true, messages = messages })
    end
end

-- ── Connect handler ──────────────────────────────────────────────────────────
local function doConnect()
    local token = tokenBox.Text:match("^%s*(.-)%s*$")
    if #token < 4 then
        setStatus("● Enter a valid token", C.red)
        return
    end
    currentToken = token
    setStatus("● Connecting...", C.yellow)

    local res = findRotex("GET", "/ping")
    if res and res.StatusCode == 200 then
        local ok2, data = pcall(function() return HttpService:JSONDecode(res.Body) end)
        if ok2 and data and data.ok then
            connected   = true
            projectName = data.project or ""
            setStatus("● Connected — " .. (projectName ~= "" and projectName or "ROTEX"), C.green)
            setActionButtons(true)
            connectBtn.Text = "Reconnect"
            plugin:SetSetting("rotex_token", token)
            clearConnectionErrors()
            appendLog("[ROTEX] Connected" .. (projectName ~= "" and (" — " .. projectName) or ""))
        else
            setStatus("● Wrong token", C.red)
        end
    else
        setStatus("● ROTEX not running — open the app", C.red)
        if not connected then
            appendLog("[Error] Could not reach ROTEX on any fallback port")
        else
            clearConnectionErrors()
            setStatus("â— Connected â€” " .. (projectName ~= "" and projectName or "ROTEX"), C.green)
        end
    end
end

connectBtn.MouseButton1Click:Connect(doConnect)
tokenBox.FocusLost:Connect(function(enter)
    if enter then doConnect() end
end)

-- ── Rojo Connect ─────────────────────────────────────────────────────────────
rojoConnBtn.MouseButton1Click:Connect(function()
    if not connected then return end
    appendLog("[Rojo] Starting...")
    local res = request("POST", "/rojo/start")
    if res and res.StatusCode == 200 then
        rojoRunning = true
        appendLog("[Rojo] Server running — sync Studio to open the project in Studio")
        setStatus("● Connected · Rojo running", C.green)
    else
        appendLog("[Rojo] Failed — is rojo installed? (rojo.space)")
    end
end)

-- ── Rojo Disconnect ──────────────────────────────────────────────────────────
rojoDiscBtn.MouseButton1Click:Connect(function()
    if not connected then return end
    local res = request("POST", "/rojo/stop")
    if res and res.StatusCode == 200 then
        rojoRunning = false
        appendLog("[Rojo] Server stopped")
        setStatus("● Connected", C.green)
    end
end)

-- ── Start ────────────────────────────────────────────────────────────────────
startBtn2.MouseButton1Click:Connect(function()
    if not connected then return end

    -- Gather selected scripts
    local scripts = {}
    for _, obj in ipairs(Selection:Get()) do
        if obj:IsA("LuaSourceContainer") and obj.Source then
            table.insert(scripts, {
                name   = obj.Name,
                source = string.sub(obj.Source, 1, 3000)
            })
        end
    end

    local contextJson = HttpService:JSONEncode({
        project = projectName,
        scripts = scripts,
    })

    local token = currentToken:match("^%s*(.-)%s*$")
    pcall(function()
        HttpService:RequestAsync({
            Url     = BASE_URL .. "/ai/start?token=" .. token,
            Method  = "POST",
            Headers = { ["Content-Type"] = "application/json" },
            Body    = contextJson,
        })
    end)

    local scriptCount = #scripts
    if scriptCount > 0 then
        appendLog("[Start] Sent " .. scriptCount .. " script(s) to ROTEX")
    else
        appendLog("[Start] Session started — select scripts in Studio for more context")
    end
    appendLog("[Start] Ask your question in the ROTEX app!")
end)

-- ── Toolbar button: toggle widget ────────────────────────────────────────────
btnOpen.Click:Connect(function()
    widget.Enabled = not widget.Enabled
end)

-- ── Auto-reconnect on load (if token saved) ──────────────────────────────────
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
