---@brief Server module for live-preview.nvim
---To require this module, do
---```lua
---local server = require('livepreview.server')
---```

local M = {}
local handler = require("livepreview.server.handler")
local get_plugin_path = require("livepreview.utils").get_plugin_path
local livepreview_utils = require("livepreview.utils")
local websocket = require("livepreview.server.websocket")
local supported_filetype = livepreview_utils.supported_filetype
local fswatch = require("livepreview.server.fswatch")
local api = vim.api

---@class FsEvent
---@field change boolean
---@field rename boolean

---@class LivePreviewServer
---To call this class, do
---```lua
---local Server = require('livepreview.server').Server
local Server = {}
Server.__index = Server

local uv = vim.uv
local need_scroll = false
local filepath = ""
M.connecting_clients = {}
local cursor_line
local operating_system = uv.os_uname().sysname

--- How long a webroot index may be reused before it is rebuilt, in seconds.
local FILE_INDEX_TTL = 10

--- Index every file under a directory by basename, keeping the shortest
--- relative path for each name. This mirrors how Obsidian resolves links:
--- `![[image.png]]` finds the file wherever it lives in the vault.
--- @param root string: webroot
--- @return table<string, string>: basename -> path relative to the webroot
local function build_file_index(root)
	local index = {}
	local pending = { root }
	while #pending > 0 do
		local dir = table.remove(pending)
		local scan = uv.fs_scandir(dir)
		if scan then
			while true do
				local name, kind = uv.fs_scandir_next(scan)
				if not name then
					break
				end
				local full = vim.fs.joinpath(dir, name)
				if not kind then
					local stat = uv.fs_stat(full)
					kind = stat and stat.type or nil
				end
				if kind == "directory" then
					if name ~= ".git" and name ~= "node_modules" and name:sub(1, 1) ~= "." then
						pending[#pending + 1] = full
					end
				elseif kind == "file" then
					local relative = full:sub(#root + 2)
					local known = index[name]
					if not known or #relative < #known then
						index[name] = relative
					end
				end
			end
		end
	end
	return index
end

---@class ServerStartOptions
---@field on_events? table<string, function(client:userdata):void>

--- Send a scroll message to a WebSocket client
--- The message is a table with the following
--- - type: "scroll"
--- - filepath: path to the file
--- - line: top line of the window
local function send_scroll()
	local cursor = api.nvim_win_get_cursor(0)
	if cursor_line == cursor[1] then
		return
	end
	if not need_scroll then
		return
	end
	if not supported_filetype(filepath) or supported_filetype(filepath) == "html" then
		return
	end
	local message = {
		type = "scroll",
		filepath = filepath or "",
		cursor = api.nvim_win_get_cursor(0),
	}
	for _, client in ipairs(M.connecting_clients) do
		websocket.send_json(client, message)
	end
	cursor_line = cursor[1]
	need_scroll = false
end

--- Build an "update" message with the current buffer's content, or nil when
--- the current buffer is not a previewable file (html updates go through the
--- file watcher instead).
--- The `path` field is the file relative to the webroot, used by the browser
--- to retarget its URL when the preview follows a different buffer.
--- @param webroot string
--- @return table|nil
function M.update_message(webroot)
	local bufname = api.nvim_buf_get_name(0)
	local ft = supported_filetype(bufname)
	if not ft or ft == "html" then
		return nil
	end
	local message = {
		filepath = bufname,
		type = "update",
		content = table.concat(api.nvim_buf_get_lines(0, 0, -1, false), "\n"),
	}
	local path = livepreview_utils.get_relative_path(bufname, webroot)
	if path then
		message.path = path
	end
	return message
end

--- Handle a WebSocket message received from a client.
--- Currently supports following wiki links: the payload is a JSON object
--- `{ type = "follow", link = "[[Note#^block-id]]" }`. The link is resolved
--- by obsidian.nvim, and the preview follows the buffer change (the server
--- pushes an update on BufEnter).
--- @param client uv_tcp_t: client connection
--- @param payload string: frame payload
function M.handle_client_message(client, payload)
	local ok, decoded = pcall(vim.json.decode, payload)
	if not ok or type(decoded) ~= "table" or decoded.type ~= "follow" then
		return
	end
	local link = decoded.link
	if type(link) ~= "string" or link == "" then
		return
	end
	vim.schedule(function()
		local ok_obs, obsidian = pcall(require, "obsidian")
		if not ok_obs then
			return
		end
		local ok_client, obs_client = pcall(obsidian.get_client)
		if ok_client and obs_client then
			obs_client:follow_link_async(link)
		end
	end)
end

--- Drop a client from the broadcast list and close its socket
--- @param client uv_tcp_t: client connection
function M.forget_client(client)
	for i, c in ipairs(M.connecting_clients) do
		if c == client then
			table.remove(M.connecting_clients, i)
			break
		end
	end
	if not client:is_closing() then
		client:close()
	end
end

--- Constructor
--- @param webroot string|nil: path to the webroot
function Server:new(webroot)
	self = setmetatable({}, Server)
	self.server = uv.new_tcp()
	self.webroot = webroot or uv.cwd()
	api.nvim_create_augroup("LivePreview", {
		clear = true,
	})

	local config = require("livepreview.config").config
	if config.sync_scroll then
		api.nvim_create_autocmd({
			"WinScrolled",
			"CursorMoved",
			"CursorMovedI",
		}, {
			callback = function()
				need_scroll = true
				filepath = api.nvim_buf_get_name(0)
				if #M.connecting_clients then
					send_scroll()
				end
			end,
		})
	end
	return self
end

--- Handle routes
--- @param path string: path from the http request
--- @return string: path to the file
function Server:routes(path)
	if path == "/" then
		path = "/index.html"
	end
	local plugin_req = "/live-preview.nvim/"
	if path:sub(1, #plugin_req) == plugin_req then
		return vim.fs.joinpath(get_plugin_path(), path:sub(#plugin_req + 1))
	else
		return vim.fs.joinpath(self.webroot, path)
	end
end

--- Resolve a request path to a file, falling back to a basename lookup in the
--- webroot when the requested path does not exist. Wiki embeds address files by
--- name (`![[image.png]]`), while the file may live in any subdirectory.
--- @param path string: path from the http request
--- @return string: path to the file
function Server:resolve(path)
	local file_path = self:routes(path)
	if path:sub(1, #"/live-preview.nvim/") == "/live-preview.nvim/" or vim.uv.fs_stat(file_path) then
		return file_path
	end
	local base = vim.fs.basename(path)
	if base == "" or base == "." then
		return file_path
	end
	local now = os.time()
	if not self._index or now - (self._index_time or 0) > FILE_INDEX_TTL then
		self._index = build_file_index(self.webroot)
		self._index_time = now
	end
	local relative = self._index[base] or (base:match("%.") and nil or self._index[base .. ".md"])
	if relative then
		return vim.fs.joinpath(self.webroot, relative)
	end
	return file_path
end

--- Watch a directory for changes and trigger an event
function Server:watch_dir()
	local callback = vim.schedule_wrap(
		---@param filename string
		---@param events {change: boolean, rename: boolean}
		function(filename, events)
			api.nvim_exec_autocmds("User", {
				pattern = "LivePreviewDirChanged",
				data = {
					filename = filename,
					events = events,
				},
			})
		end
	)
	local function on_change(err, filename, events)
		if err then
			print("Watch error: " .. err)
			return
		end
		callback(filename, events)
	end
	local function watch(path, recursive)
		local handle = uv.new_fs_event()
		if not handle then
			print("Failed to create fs event")
			return
		end
		handle:start(path, { recursive = recursive }, on_change)
		return handle
	end

	if operating_system == "Windows" or operating_system == "Darwin" then
		watch(self.webroot, true)
	else
		local watcherObj = fswatch.Watcher:new(self.webroot)
		watcherObj:start(function(filename, events)
			callback(filename, events)
		end)
		self._watcher = watcherObj
	end
end

--- Start the server
--- @param ip string: IP address to bind to
--- @param port number: port to bind to
--- @param opts ServerStartOptions: a table with the following fields
--- 	- on_events (table<string, function(client:userdata, data:{filename: string, events: FsEvent}):void>)
function Server:start(ip, port, opts)
	self.server:bind(ip, port)
	local on_events = opts.on_events
	if on_events then
		if on_events.LivePreviewDirChanged then
			self:watch_dir()
		end
		for k, v in pairs(opts.on_events) do
			if k:match("^LivePreview*") then
				api.nvim_create_autocmd("User", {
					group = "LivePreview",
					pattern = k,
					callback = function(param)
						for _, client in ipairs(M.connecting_clients) do
							v(client, param.data)
						end
					end,
				})
			else
				api.nvim_create_autocmd(k, {
					pattern = "*",
					group = "LivePreview",
					callback = function()
						for _, client in ipairs(M.connecting_clients) do
							v(client)
						end
					end,
				})
			end
		end
	end

	self.server:listen(128, function(err)
		--- Connect to client
		local client = uv.new_tcp()
		self.server:accept(client)
		handler.client(client, function(error, request)
			if error or not request then
				vim.notify(error and error, vim.log.levels.ERROR)
				M.forget_client(client)
				return
			else
				local req_info = handler.request(client, request)
				if req_info then
					local path = req_info.path
					local if_none_match = req_info.if_none_match
					local accept = req_info.accept
					local file_path = self:resolve(path)
					-- serve_file closes the connection once the response is sent
					handler.serve_file(client, file_path, if_none_match, accept)
				elseif not client:is_closing() then
					-- handler.request returns nil only after a WebSocket
					-- upgrade, and broadcasts must reach nothing else.
					table.insert(M.connecting_clients, client)
					-- Reads were stopped once the upgrade request was buffered,
					-- so a closed tab would go unnoticed. Also parse any frames
					-- the client sends upstream (e.g. wiki link follow clicks).
					local recv_buf = ""
					client:read_start(function(read_err, chunk)
						if read_err or not chunk then
							M.forget_client(client)
							return
						end
						recv_buf = recv_buf .. chunk
						while true do
							local payload, rest, close_conn = websocket.parse_client_frame(recv_buf)
							if rest == recv_buf then
								break -- incomplete frame, wait for more data
							end
							recv_buf = rest
							if close_conn then
								M.forget_client(client)
								return
							end
							if payload ~= nil then
								M.handle_client_message(client, payload)
							end
						end
					end)
				end
			end
		end)
	end)
end

--- Stop the server
--- @param callback? function: callback to run after the server is stopped
function Server:stop(callback)
	-- Closing the listener alone leaves the still-open WebSocket sockets
	-- behind, holding their file descriptors until Neovim exits.
	for i = #M.connecting_clients, 1, -1 do
		M.forget_client(M.connecting_clients[i])
	end
	if self.server then
		self.server:close(function()
			self.server = nil
			if callback then
				callback()
			end
		end)
	end
	if self._watcher then
		self._watcher:close()
	end
	self._watcher = nil
	api.nvim_del_augroup_by_name("LivePreview")
end

M.Server = Server
M.handler = require("livepreview.server.handler")
M.utils = require("livepreview.server.utils")
M.websocket = require("livepreview.server.websocket")
M.fswatch = require("livepreview.server.fswatch")
return M
