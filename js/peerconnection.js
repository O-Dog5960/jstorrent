function PeerConnection(opts) {
    jstorrent.Item.apply(this, arguments)

    
    this.peer = opts.peer
    this.torrent = opts.peer.torrent

    // initial bittorrent state settings
    this.amInterested = false
    this.amChoked = true
    this.peerInterested = false
    this.peerChoked = true

    this.peerHandshake = null
    this.peerExtensionHandshake = null
    this.peerExtensionHandshakeCodes = {}
    this.peerPort = null
    this.peerBitfield = null

    this.set('address', this.peer.get_key())
    this.set('bytes_sent', 0)
    this.set('bytes_received', 0)

    // piece/chunk requests
    this.pieceChunkRequests = {}
    this.pieceChunkRequestsLinear = [] // perhaps store them in linear
                                       // request order to make
                                       // timeouts easy to process
    this.pieceChunkRequestCount = 0
    this.pieceChunkRequestPipelineLimit = 4

    // inefficient that we create this for everybody in the
    // swarm... (not actual peer objects) but whatever, good enough
    // for now
    this.registeredRequests = {}
    this.infodictResponses = []
    this.handleAfterInfodict = []

    // connect state
    this.connect_timeout_delay = 10000
    this.connect_timeout_callback = null
    this.connecting = false
    this.connect_timeouts = 0

    // read/write buffer stuff
    this.writing = false
    this.writing_length = 0
    this.reading = false
    this.readBuffer = new jstorrent.Buffer
    this.writeBuffer = new jstorrent.Buffer
}

jstorrent.PeerConnection = PeerConnection;

PeerConnection.prototype = {
    get_key: function() {
        return this.peer.host + ':' + this.peer.port
    },
    on_connect_timeout: function() {
        console.error('connect timeout!')
        this.connecting = false;
        this.connect_timeouts++;
        chrome.socket.destroy( this.sockInfo.socketId )
        this.sockInfo = null
        this.trigger('connect_timeout')
    },
    close: function(reason) {
        this.log('closing',reason)
        chrome.socket.disconnect(this.sockInfo.socketId)
        chrome.socket.destroy(this.sockInfo.socketId)
        this.sockInfo = null
        this.trigger('disconnect')
    },
    connect: function() {
        console.log('peer connect!')
        console.assert( ! this.connecting )
        this.connecting = true;
        this.set('state','connecting')
        chrome.socket.create('tcp', {}, _.bind(this.oncreate, this))
    },
    oncreate: function(sockInfo) {
        this.sockInfo = sockInfo;
        //this.log('peer oncreate')
        this.connect_timeout_callback = setTimeout( _.bind(this.on_connect_timeout, this), this.connect_timeout_delay )
        chrome.socket.connect( sockInfo.socketId, this.peer.host, this.peer.port, _.bind(this.onconnect, this) )
    },
    onconnect: function(connectInfo) {
        if (connectInfo < 0) {
            console.error('socket connect error:',connectInfo)
            this.error('connect_error')
            return
        }

        if (! this.sockInfo) {
            console.log('onconnect, but we already timed out')
        }
        //this.log('peer onconnect',connectInfo);
        this.set('state','connected')
        this.peer.set('connected_ever',true)
        if (this.connect_timeout_callback) {
            clearTimeout( this.connect_timeout_callback )
            this.connect_timeout_callback = null
            this.connecting = false
        }
        this.doRead()
        this.sendHandshake()
        this.sendExtensionHandshake()
    },
    doRead: function() {
        console.assert(! this.reading)
        if (this.reading) { return }
        this.reading = true
        chrome.socket.read( this.sockInfo.socketId, jstorrent.protocol.socketReadBufferMax, _.bind(this.onRead,this) )
    },
    sendExtensionHandshake: function() {
        var data = {v: jstorrent.protocol.reportedClientName,
                    m: jstorrent.protocol.extensionMessages}
        if (this.torrent.has_infodict()) {
            data.metadata_size = this.torrent.infodict_buffer.byteLength
        }
        var arr = new Uint8Array(bencode( data )).buffer;
        this.sendMessage('UTORRENT_MSG', [new Uint8Array([0]).buffer, arr])
    },
    sendMessage: function(type, payloads) {
        switch (type) {
        case "INTERESTED":
            this.amInterested = true
            break
        case "NOT_INTERESTED":
            this.amInterested = false
            break
        case "CHOKE":
            this.peerChoked = true
            break
        case "UNCHOKE":
            this.peerChoked = false
            break
        }
        
        if (! payloads) { payloads = [] }
        //console.log('Sending Message',type)
        console.assert(jstorrent.protocol.messageNames[type] !== undefined)
        var payloadsz = 0
        for (var i=0; i<payloads.length; i++) {
            console.assert(payloads[i] instanceof ArrayBuffer)
            payloadsz += payloads[i].byteLength
        }
        var b = new Uint8Array(payloadsz + 5)
        var v = new DataView(b.buffer, 0, 5)
        v.setUint32(0, payloadsz + 1) // this plus one is important :-)
        v.setUint8(4, jstorrent.protocol.messageNames[type])
        var idx = 5
        for (var i=0; i<payloads.length; i++) {
            b.set( new Uint8Array(payloads[i]), idx )
            idx += payloads[i].byteLength
        }
        //console.log('sending message', new Uint8Array(b))
        this.write(b)
    },
    sendHandshake: function() {
        var bytes = []
        bytes.push( jstorrent.protocol.protocolName.length )
        for (var i=0; i<jstorrent.protocol.protocolName.length; i++) {
            bytes.push( jstorrent.protocol.protocolName.charCodeAt(i) )
        }
        // handshake flags, null for now
        bytes = bytes.concat( [0,0,0,0,0,0,0,0] )
        bytes = bytes.concat( this.torrent.hashbytes )
        bytes = bytes.concat( this.torrent.client.peeridbytes )
        console.assert( bytes.length == jstorrent.protocol.handshakeLength )
        this.write( new Uint8Array( bytes ).buffer )
    },
    write: function(data) {
        console.assert(data.byteLength > 0)
        this.writeBuffer.add(data)
        if (! this.writing) {
            this.writeFromBuffer()
        }
    },
    writeFromBuffer: function() {
        console.assert(! this.writing)
        var data = this.writeBuffer.consume_any_max(jstorrent.protocol.socketWriteBufferMax)
        //this.log('write',data.byteLength)
        this.writing = true
        this.writing_length = data.byteLength
        chrome.socket.write( this.sockInfo.socketId, data, _.bind(this.onWrite,this) )
    },
    onWrite: function(writeResult) {
        if (! this.sockInfo) {
            console.error('onwrite for socket forcibly or otherwise closed')
            return
        }

        //this.log('onWrite', writeResult)
        // probably only need to worry about partial writes with really large buffers
        if(writeResult.bytesWritten != this.writing_length) {
            console.error('bytes written does not match!')
            chrome.socket.getInfo( this.sockInfo.socketId, function(socketStatus) {
                console.log('socket info -',socketStatus)
            })
            this.error('did not write everything')
        } else {
            this.set('bytes_sent', this.get('bytes_sent') + this.writing_length)
            this.writing = false
            this.writing_length = 0
            // continue writing out write buffer
            if (this.writeBuffer.size() > 0) {
                this.writeFromBuffer()
            } else {
                this.newStateThink()
            }
        }
    },
    registerChunkRequest: function(pieceNum, chunkNum, chunkOffset, chunkSize) {
        this.pieceChunkRequestCount++
        //console.log('++increment pieceChunkRequestCount', this.pieceChunkRequestCount)
        //console.log('registering chunk request',this.get_key(),pieceNum, chunkNum)
        if (! this.pieceChunkRequests[pieceNum]) {
            this.pieceChunkRequests[pieceNum] = {}
        }
        this.pieceChunkRequests[pieceNum][chunkNum] = [chunkOffset, chunkSize, new Date()]
        // when to timeout request?
    },
    registerChunkResponse: function(pieceNum, chunkNum, offset, data) {
        if (this.pieceChunkRequests[pieceNum] &&
            this.pieceChunkRequests[pieceNum][chunkNum]) {
            // we were expecting this
            this.pieceChunkRequestCount--
            //console.log('--decrement pieceChunkRequestCount', this.pieceChunkRequestCount)
            delete this.pieceChunkRequests[pieceNum][chunkNum]
            return true
        } else {
            console.warn('was not expecting this piece',pieceNum,offset)
            return false
        }
    },
    couldRequestPieces: function() {
        //console.log('couldRequestPieces')
        if (this.pieceChunkRequestCount > this.pieceChunkRequestPipelineLimit) {
            return
        }

        if (this.torrent.unflushedPieceDataSize > this.torrent.client.app.options.get('max_unflushed_piece_data')) {
            console.log('not requesting more pieces -- need disk io to write out more first')
            return
        }

        // called when everything is ready and we could request
        // torrent pieces!
        var curPiece, payloads
        var allPayloads = []

        for (var pieceNum=this.torrent.bitfieldFirstMissing; pieceNum<this.torrent.numPieces; pieceNum++) {
            if (this.peerBitfield[pieceNum]) {
                curPiece = this.torrent.getPiece(pieceNum)

                while (this.pieceChunkRequestCount < this.pieceChunkRequestPipelineLimit) {
                    //console.log('getting chunk requests for peer')
                    payloads = curPiece.getChunkRequestsForPeer(1, this)
                    if (payloads.length == 0) {
                        break
                    } else {
                        allPayloads = allPayloads.concat(payloads)
                    }
                }
            }

            if (this.pieceChunkRequestCount >= this.pieceChunkRequestPipelineLimit) {
                break
            }
        }

        for (var i=0; i<allPayloads.length; i++) {
            this.sendMessage("REQUEST", [allPayloads[i]])
        }
    },
    registerExpectResponse: function(type, key, info) {
        // used for non-PIECE type messages
        if (! this.registeredRequests[type]) {
            this.registeredRequests[type] = {}
        }
        this.registeredRequests[type][key] = info
    },
    newStateThink: function() {
        //console.log('newStateThink')
        // thintk about the next thing we might want to write to the socket :-)

        if (this.torrent.has_infodict()) {

            // we have valid infodict
            if (this.handleAfterInfodict.length > 0) {
                console.log('processing afterinfodict:',this.handleAfterInfodict)
                var msg = this.handleAfterInfodict.shift()
                //setTimeout( _.bind(function(){this.handleMessage(msg)},this), 1 )
                this.handleMessage(msg)
            } else {
                if (this.torrent.started) {
                    if (! this.amInterested) {
                        this.sendMessage("INTERESTED")
                    } else {
                        if (! this.amChoked) {
                            this.couldRequestPieces()
                        }
                    }
                }
            }
        } else {
            if (this.peerExtensionHandshake && 
                this.peerExtensionHandshake.m && 
                this.peerExtensionHandshake.m.ut_metadata &&
                this.peerExtensionHandshake.metadata_size &&
                this.torrent.connectionsServingInfodict.length == 0)
            {
                // we have no infodict and this peer does!
                this.torrent.connectionsServingInfodict.push( this )
                this.requestInfodict()
            }
        }
    },
    requestInfodict: function() {
        var infodictBytes = this.peerExtensionHandshake.metadata_size
        var d
        var numChunks = Math.ceil( infodictBytes / jstorrent.protocol.pieceSize )
        for (var i=0; i<numChunks; i++) {
            this.infodictResponses.push(null)
        }

        for (var i=0; i<numChunks; i++) {
            d = {
                piece: i,
                msg_type: jstorrent.protocol.infodictExtensionMessageNames.REQUEST,
                total_size: infodictBytes
            }
            var code = this.peerExtensionHandshake.m.ut_metadata
            var info = {}
            this.registerExpectResponse('infodictRequest', i, info)
            this.sendMessage('UTORRENT_MSG', [new Uint8Array([code]).buffer, new Uint8Array(bencode(d)).buffer])
        }
    },
    log: function() {
        var args = [this.sockInfo.socketId, this.peer.get_key()]
        for (var i=0; i<arguments.length; i++) {
            args.push(arguments[i])
        }
        console.log.apply(console, args)
    },
    error: function(msg) {
        this.log(msg)
        chrome.socket.disconnect(this.sockInfo.socketId)
        chrome.socket.destroy(this.sockInfo.socketId)
        this.trigger('error')
    },
    onRead: function(readResult) {

        if (! this.torrent.started) {
            console.error('onRead, but torrent stopped')
            this.close('torrent stopped')
        }

        this.reading = false
        if (! this.sockInfo) {
            console.error('onwrite for socket forcibly or otherwise closed')
            return
        }
        if (readResult.data.byteLength == 0) {
            this.close('peer closed socket (read 0 bytes)')
            return
        } else {
            this.set('bytes_received', this.get('bytes_received') + readResult.data.byteLength)
            //this.log('onRead',readResult.data.byteLength)
            this.readBuffer.add( readResult.data )
            this.checkBuffer()
            this.doRead() // TODO -- only if we are actually interested right now...
        }
        //this.close('no real reason')
    },
    checkBuffer: function() {
        // checks if there are messages
        if (! this.peerHandshake) {
            if (this.readBuffer.size() >= jstorrent.protocol.handshakeLength) {
                var buf = this.readBuffer.consume(jstorrent.protocol.handshakeLength)
                this.peerHandshake = jstorrent.protocol.parseHandshake(buf)
                if (! this.peerHandshake) {
                    this.close('invalid handshake')
                }
                this.checkBuffer()
            }
        } else {
            // have peer handshake!
            var curbufsz = this.readBuffer.size()
            if (curbufsz >= 4) {
                var msgsize = new DataView(this.readBuffer.consume(4,true)).getUint32(0)
                if (msgsize > jstorrent.protocol.maxPacketSize) {
                    this.close('message too large')
                } else {
                    if (curbufsz >= msgsize + 4) {
                        var msgbuf = this.readBuffer.consume(msgsize + 4)
                        this.parseMessage(msgbuf)
                    }
                }
            }
        }
    },
    parseMessage: function(buf) {
        var data = {}
        //console.log('handling bittorrent message', new Uint8Array(buf))
        var msgsz = new DataView(buf, 0, 4).getUint32(0)
        if (msgsz == 0) {
            data.type = 'keepalive'
            // keepalive message
        } else {
            data.code = new Uint8Array(buf, 4, 1)[0]
            var messageString = jstorrent.protocol.messageCodes[data.code]
            data.type = messageString
            data.payload = buf
        }

        console.log('handling message',data)

        this.handleMessage(data)
    },
    handleMessage: function(msgData) {
        var method = this['handle_' + msgData.type]
        if (! method) {
            this.unhandledMessage(msgData)
        } else {
            method.apply(this,[msgData])
        }
        // once a message is handled, there is new state, so check if
        // we want to write something
        this.newStateThink()
    },
    handle_PIECE: function(msg) {
        var v = new DataView(msg.payload, 5, 12)
        var pieceNum = v.getUint32(0)
        var chunkOffset = v.getUint32(4)
        // does not send size, inherent in message. could be smaller than chunk size though!
        var data = new Uint8Array(msg.payload, 5+8)
        console.assert(data.length <= jstorrent.protocol.chunkSize)
        this.torrent.getPiece(pieceNum).registerChunkResponseFromPeer(this, chunkOffset, data)
    },
    handle_UNCHOKE: function() {
        this.amChoked = false
    },
    handle_CHOKE: function() {
        this.amChoked = true
    },
    handle_INTERESTED: function() {
        this.peerInterested = true
    },
    handle_NOT_INTERESTED: function() {
        this.peerInterested = false
    },
    handle_PORT: function(msg) {
        // peer's listening port
        this.peerPort = msg
    },
    handle_UTORRENT_MSG: function(msg) {
        // extension message!
        var extType = new DataView(msg.payload, 5, 1).getUint8(0)
        if (extType == jstorrent.protocol.extensionMessageHandshakeCode) {
            // bencoded extension message handshake follows
            this.peerExtensionHandshake = bdecode(ui82str(new Uint8Array(msg.payload, 6)))
            if (this.peerExtensionHandshake.m) {
                for (var key in this.peerExtensionHandshake.m) {
                    this.peerExtensionHandshakeCodes[this.peerExtensionHandshake.m[key]] = key
                }
            }
        } else if (jstorrent.protocol.extensionMessageCodes[extType]) {
            var extMsgType = jstorrent.protocol.extensionMessageCodes[extType]

            if (extMsgType == 'ut_metadata') {

                this.handle_UTORRENT_MSG_ut_metadata(msg, extMsgType)
            } else {
                debugger
            }
        } else {
            debugger
        }
        
    },
    handle_UTORRENT_MSG_ut_metadata: function(msg, extMsgType) {
        var extMessageBencodedData = bdecode(ui82str(new Uint8Array(msg.payload),6))
        var infodictCode = extMessageBencodedData.msg_type
        var infodictMsgType = jstorrent.protocol.infodictExtensionMessageCodes[infodictCode]

        if (infodictMsgType == 'DATA') {
            // looks like response to metadata request! yay

            var dataStartIdx = bencode(extMessageBencodedData).length;
            var infodictDataChunk = new Uint8Array(msg.payload, 6 + dataStartIdx)
            var infodictChunkNum = extMessageBencodedData.piece

            if (this.registeredRequests['infodictRequest'][infodictChunkNum]) {
                this.registeredRequests['infodictRequest'][infodictChunkNum].received = true
                this.infodictResponses[infodictChunkNum] = infodictDataChunk

                var ismissing = false // check if we received everything
                for (var i=0; i<this.infodictResponses.length; i++) {
                    if (this.infodictResponses[i] === null) {
                        ismissing = true
                    }
                }
                if (! ismissing) {
                    // we have everything now! make sure it matches torrent hash
                    this.processCompleteInfodictResponses()
                }
            } else {
                console.error("was not expecting this torrent metadata piece")
            }

        } else {
            debugger
        }
    },
    processCompleteInfodictResponses: function() {
        var b = new Uint8Array(this.peerExtensionHandshake.metadata_size)
        var idx = 0
        for (var i=0; i<this.infodictResponses.length; i++) {
            b.set( this.infodictResponses[i], idx )
            idx += this.infodictResponses[i].byteLength
        }
        console.assert(idx == this.peerExtensionHandshake.metadata_size)

        var infodict = bdecode(ui82str(b))
        var metadata = {info:infodict} // should perhaps add in the trackers and shit
        var digest = new Digest.SHA1()
        digest.update(b)
        var receivedInfodictHash = new Uint8Array(digest.finalize())

        if (ui82str(receivedInfodictHash) == ui82str(this.torrent.hashbytes)) {
            console.log("%c Received valid infodict!", 'background:#3f3; color:#fff')
            this.torrent.infodict_buffer = b
            this.torrent.infodict = infodict
            this.torrent.metadata = metadata
            this.torrent.metadataPresentInitialize()
        } else {
            console.error('received metadata does not have correct infohash! bad!')
            this.error('bad_metadata')
        }
        

    },
    doAfterInfodict: function(msg) {
        console.warn('Deferring message until have infodict',msg.type)
        this.handleAfterInfodict.push( msg )
    },
    handle_HAVE_ALL: function(msg) {
        if (! this.torrent.has_infodict()) {
            this.doAfterInfodict(msg)
        } else {
            //console.log('handling HAVE_ALL')
            if (! this.peerBitfield) {
                var arr = []
                for (var i=0; i<this.torrent.numPieces; i++) {
                    arr.push(1)
                }
                // it would be cool to use an actual bitmask and save
                // some space. but that's silly :-)
                this.peerBitfield = new Uint8Array(arr)
            } else {
                for (var i=0; i<this.peerBitfield.byteLength; i++) {
                    this.peerBitfield[i] = 1
                }
            }
        }
    },
    handle_BITFIELD: function(msg) {
        if (! this.torrent.has_infodict()) {
            this.doAfterInfodict(msg)
        } else {
            debugger;
        }
    },
    handle_HAVE: function(msg) {
        if (! this.torrent.has_infodict()) {
            this.doAfterInfodict(msg)
        } else {
            debugger;
        }
    },
    unhandledMessage: function(msg) {
        console.error('unhandled message',msg.type)
        debugger
    }
}

for (var method in jstorrent.Item.prototype) {
    jstorrent.PeerConnection.prototype[method] = jstorrent.Item.prototype[method]
}