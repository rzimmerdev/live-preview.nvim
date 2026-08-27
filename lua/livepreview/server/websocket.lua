---@brief WebSocket server implementation
--- To require this module, do
--- ```lua
--- local websocket = require('livepreview.server.websocket')
--- ```

local sha1 = require("livepreview.utils").sha1

local M = {}

--- Handle a WebSocket handshake request
--- @param client uv_tcp_t: client
--- @param request string: client request
function M.handshake(client, request)
	local key = request:match("Sec%-WebSocket%-Key: ([^\r\n]+)")
	if not key then
		vim.print("Invalid WebSocket request from client")
		client:close()
		return nil
	end

	local accept = sha1(key .. "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
	accept = vim.base64.encode(accept)
	accept = vim.trim(accept)

	local response = "HTTP/1.1 101 Switching Protocols\r\n"
		.. "Upgrade: websocket\r\n"
		.. "Connection: Upgrade\r\n"
		.. "Sec-WebSocket-Accept: "
		.. accept
		.. "\r\n\r\n"
	client:write(response)
end

--- Send a message to a WebSocket client
--- @param client uv_tcp_t: client
--- @param message string: message to send
function M.send(client, message)
	local byteMessage = message
	local length = #byteMessage

	local frame = string.char(0x81)

	if length <= 125 then
		frame = frame .. string.char(length) .. byteMessage
	elseif length <= 65535 then
		frame = frame .. string.char(126) .. string.char(bit.rshift(length, 8), length % 256) .. byteMessage
	else
		frame = frame
			.. string.char(127)
			.. string.char(
				bit.rshift(length, 56),
				bit.rshift(length, 48) % 256,
				bit.rshift(length, 40) % 256,
				bit.rshift(length, 32) % 256,
				bit.rshift(length, 24) % 256,
				bit.rshift(length, 16) % 256,
				bit.rshift(length, 8) % 256,
				length % 256
			)
			.. byteMessage
	end

	client:write(frame)
end

--- Send a JSON message to a WebSocket client
--- @param client uv_tcp_t: client connection
--- @param message table: message to send
function M.send_json(client, message)
	local json = vim.json.encode(message)
	M.send(client, json)
end

--- Parse the next client-to-server WebSocket frame from a buffer.
--- Client frames are always masked (RFC 6455). Text frames carry a payload;
--- close frames signal the end of the connection; other opcodes are ignored.
--- @param buf string: accumulated bytes
--- @return string|nil payload: text payload of a complete text frame
--- @return string rest: remaining unparsed bytes (== buf when more data is needed)
--- @return boolean close: true when the frame was a close frame or a protocol error
function M.parse_client_frame(buf)
	if #buf < 2 then
		return nil, buf, false
	end
	local b0 = buf:byte(1)
	local b1 = buf:byte(2)
	local opcode = b0 % 16
	local masked = b1 >= 128
	if not masked then
		-- Client frames MUST be masked; treat as a protocol error.
		return nil, buf, true
	end
	local len = b1 % 128
	local offset = 2
	if len == 126 then
		if #buf < 4 then
			return nil, buf, false
		end
		len = buf:byte(3) * 256 + buf:byte(4)
		offset = 4
	elseif len == 127 then
		if #buf < 10 then
			return nil, buf, false
		end
		len = 0
		for i = 3, 10 do
			len = len * 256 + buf:byte(i)
		end
		offset = 10
	end
	if #buf < offset + 4 then
		return nil, buf, false
	end
	local mask = buf:sub(offset + 1, offset + 4)
	offset = offset + 4
	if #buf < offset + len then
		return nil, buf, false
	end
	local payload = buf:sub(offset + 1, offset + len)
	local rest = buf:sub(offset + len + 1)
	if opcode == 0x8 then -- close
		return nil, rest, true
	end
	if opcode ~= 0x1 then -- ignore ping/pong/continuation frames
		return nil, rest, false
	end
	-- Unmask the payload.
	local out = {}
	for i = 1, #payload do
		out[i] = string.char(bit.bxor(payload:byte(i), mask:byte(((i - 1) % 4) + 1)))
	end
	return table.concat(out), rest, false
end

return M
