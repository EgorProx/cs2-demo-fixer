/*!
 * CS2 Demo Fixer - independent, dependency-free core.
 *
 * Repairs CS2 demos ("PBDEMS2") that crash on playback because a pet chicken's
 * instancebaseline arrives on the first game packet instead of in the signon
 * data. The demo format and the repair idea are documented by the MIT-licensed
 * project NewTanachot/cs2-faceit-demo-fixer. This file is a separate
 * implementation and uses no third-party code.
 *
 * It only reads the bytes it is given and returns new bytes. No network,
 * no eval, no child processes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DemoFix = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  var CMD = {
    Stop: 0, FileHeader: 1, FileInfo: 2, SyncTick: 3, SendTables: 4,
    ClassInfo: 5, StringTables: 6, Packet: 7, SignonPacket: 8,
    ConsoleCmd: 9, FullPacket: 13, SpawnGroups: 15
  };
  var CMD_COMPRESSED = 64;
  var SVC_CREATE_STRING_TABLE = 44;
  var SVC_UPDATE_STRING_TABLE = 45;
  var SVC_CLEAR_ALL_STRING_TABLES = 51;
  var GE_GAME_EVENT_LIST = 205;
  var GE_GAME_EVENT = 207;
  var FOLD_TABLES = ['instancebaseline', 'AnimAssetData'];

  var POW2 = [];
  for (var p = 0; p <= 53; p++) POW2.push(Math.pow(2, p));

  function DemoError(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  function concat(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return out;
  }

  function bytesEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function toHex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) {
      s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
      if (i + 1 < b.length) s += ' ';
    }
    return s;
  }

  var textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  function decodeText(b) {
    if (!b || b.length === 0) return '';
    if (textDecoder) return textDecoder.decode(b);
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  function readInt32LE(u8, o) {
    return (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24));
  }
  function int32LE(v) {
    return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  }

  // ---------------------------------------------------------------- varints
  function readVarint(u8, pos) {
    var v = 0, shift = 0, b;
    do {
      if (pos >= u8.length) throw DemoError('TRUNCATED', 'Unexpected end of data');
      b = u8[pos++];
      if (shift < 53) v += (b & 0x7f) * POW2[shift];
      shift += 7;
    } while (b & 0x80);
    return [v, pos];
  }

  function varintBytes(v) {
    var out = [];
    do {
      var b = v % 128;
      v = Math.floor(v / 128);
      out.push(v > 0 ? (b | 0x80) : b);
    } while (v > 0);
    return new Uint8Array(out);
  }

  // ---------------------------------------------------------------- protobuf
  function parseFields(u8) {
    var out = [], pos = 0, n = u8.length, r;
    while (pos < n) {
      var start = pos;
      r = readVarint(u8, pos); var key = r[0]; pos = r[1];
      var fn = Math.floor(key / 8), wt = key % 8, v, raw;
      if (wt === 0) {
        r = readVarint(u8, pos); v = r[0]; pos = r[1];
      } else if (wt === 2) {
        r = readVarint(u8, pos); var len = r[0]; pos = r[1];
        if (pos + len > n) throw DemoError('BAD_PROTOBUF', 'Length-delimited field overruns message');
        v = u8.subarray(pos, pos + len); pos += len;
      } else if (wt === 1) {
        if (pos + 8 > n) throw DemoError('BAD_PROTOBUF', 'Field overruns message');
        v = u8.subarray(pos, pos + 8); pos += 8;
      } else if (wt === 5) {
        if (pos + 4 > n) throw DemoError('BAD_PROTOBUF', 'Field overruns message');
        v = u8.subarray(pos, pos + 4); pos += 4;
      } else {
        throw DemoError('BAD_PROTOBUF', 'Unsupported wire type ' + wt);
      }
      raw = u8.subarray(start, pos);
      out.push({ fn: fn, wt: wt, v: v, raw: raw });
    }
    return out;
  }

  function getField(fields, fn) {
    for (var i = 0; i < fields.length; i++) if (fields[i].fn === fn) return fields[i].v;
    return undefined;
  }

  function encField(fn, wt, v) {
    var key = varintBytes(fn * 8 + wt);
    if (wt === 0) return concat([key, varintBytes(v)]);
    if (wt === 2) return concat([key, varintBytes(v.length), v]);
    return concat([key, v]);
  }

  function encFields(fields) {
    var parts = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      parts.push(f.raw ? f.raw : encField(f.fn, f.wt, f.v));
    }
    return concat(parts);
  }

  function setField(fields, fn, wt, v) {
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].fn === fn) {
        fields[i] = { fn: fn, wt: wt, v: v, raw: null };
        return;
      }
    }
    fields.push({ fn: fn, wt: wt, v: v, raw: null });
  }

  // ---------------------------------------------------------------- snappy
  function snappyDecode(src) {
    if (src.length === 0) throw DemoError('BAD_SNAPPY', 'Empty snappy stream');
    var r = readVarint(src, 0), len = r[0], pos = r[1];
    var out = new Uint8Array(len), op = 0, n = src.length;
    while (pos < n) {
      var tag = src[pos++], type = tag & 3, l, off;
      if (type === 0) {
        l = tag >>> 2;
        if (l >= 60) {
          var nb = l - 59; l = 0;
          for (var i = 0; i < nb; i++) {
            if (pos >= n) throw DemoError('BAD_SNAPPY', 'Truncated literal length');
            l += src[pos++] * POW2[8 * i];
          }
        }
        l += 1;
        if (pos + l > n || op + l > len) throw DemoError('BAD_SNAPPY', 'Corrupt compressed data (literal)');
        out.set(src.subarray(pos, pos + l), op);
        pos += l; op += l;
      } else {
        if (type === 1) {
          if (pos >= n) throw DemoError('BAD_SNAPPY', 'Truncated copy');
          l = ((tag >>> 2) & 7) + 4;
          off = ((tag >>> 5) << 8) | src[pos++];
        } else if (type === 2) {
          if (pos + 2 > n) throw DemoError('BAD_SNAPPY', 'Truncated copy');
          l = (tag >>> 2) + 1;
          off = src[pos] | (src[pos + 1] << 8); pos += 2;
        } else {
          if (pos + 4 > n) throw DemoError('BAD_SNAPPY', 'Truncated copy');
          l = (tag >>> 2) + 1;
          off = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0;
          pos += 4;
        }
        if (off === 0 || off > op || op + l > len) throw DemoError('BAD_SNAPPY', 'Corrupt compressed data (copy)');
        var from = op - off;
        if (off >= l) { out.copyWithin(op, from, from + l); op += l; }
        else { for (var k = 0; k < l; k++) out[op++] = out[from++]; }
      }
    }
    if (op !== len) throw DemoError('BAD_SNAPPY', 'Corrupt compressed data (length)');
    return out;
  }

  // Valid raw-snappy stream containing exactly one literal block.
  function snappyStore(src) {
    var n = src.length, pre = varintBytes(n);
    if (n === 0) return pre;
    var l = n - 1, hdr;
    if (l < 60) hdr = [l << 2];
    else if (l < 0x100) hdr = [240, l];
    else if (l < 0x10000) hdr = [244, l & 255, l >>> 8];
    else if (l < 0x1000000) hdr = [248, l & 255, (l >>> 8) & 255, l >>> 16];
    else hdr = [252, l & 255, (l >>> 8) & 255, (l >>> 16) & 255, (l >>> 24) & 255];
    return concat([pre, new Uint8Array(hdr), src]);
  }

  // ---------------------------------------------------------------- bit IO
  function BitReader(u8) {
    this.u8 = u8;
    this.pos = 0;
    this.len = u8.length * 8;
  }
  BitReader.prototype.left = function () { return this.len - this.pos; };
  BitReader.prototype.bits = function (n) {
    if (n < 0 || this.pos + n > this.len) throw DemoError('BAD_BITSTREAM', 'Read past end of bitstream');
    var v = 0, got = 0;
    while (got < n) {
      var off = this.pos & 7, take = 8 - off;
      if (take > n - got) take = n - got;
      var byte = this.u8[this.pos >>> 3];
      v += ((byte >>> off) & ((1 << take) - 1)) * POW2[got];
      got += take;
      this.pos += take;
    }
    return v;
  };
  BitReader.prototype.bytes = function (n) {
    if (n < 0 || this.pos + n * 8 > this.len) throw DemoError('BAD_BITSTREAM', 'Read past end of bitstream');
    var off = this.pos & 7, start = this.pos >>> 3, out;
    if (off === 0) {
      out = this.u8.slice(start, start + n);
    } else {
      out = new Uint8Array(n);
      var inv = 8 - off;
      for (var i = 0; i < n; i++) {
        var a = this.u8[start + i];
        var b = (start + i + 1 < this.u8.length) ? this.u8[start + i + 1] : 0;
        out[i] = ((a >>> off) | (b << inv)) & 0xff;
      }
    }
    this.pos += n * 8;
    return out;
  };
  BitReader.prototype.skipBytes = function (n) {
    if (n < 0 || this.pos + n * 8 > this.len) throw DemoError('BAD_BITSTREAM', 'Read past end of bitstream');
    this.pos += n * 8;
  };
  BitReader.prototype.ubitvar = function () {
    var r = this.bits(6);
    switch (r & 48) {
      case 16: r = (r & 15) + this.bits(4) * 16; break;
      case 32: r = (r & 15) + this.bits(8) * 16; break;
      case 48: r = (r & 15) + this.bits(28) * 16; break;
    }
    return r;
  };
  BitReader.prototype.varint32 = function () {
    var r = 0, shift = 0, b;
    do {
      b = this.bits(8);
      r += (b & 0x7f) * POW2[shift];
      shift += 7;
    } while ((b & 0x80) && shift < 35);
    return r;
  };
  BitReader.prototype.cstring = function () {
    var out = [];
    for (;;) {
      if (out.length > (1 << 20)) throw DemoError('BAD_BITSTREAM', 'String too long');
      var c = this.bits(8);
      if (c === 0) return new Uint8Array(out);
      out.push(c);
    }
  };

  function BitWriter(cap) {
    this.buf = new Uint8Array(cap || 256);
    this.pos = 0;
  }
  BitWriter.prototype.ensure = function (nbits) {
    var need = ((this.pos + nbits + 7) >>> 3) + 2;
    if (need > this.buf.length) {
      var nb = new Uint8Array(Math.max(need, this.buf.length * 2));
      nb.set(this.buf);
      this.buf = nb;
    }
  };
  BitWriter.prototype.bits = function (v, n) {
    this.ensure(n);
    var pos = this.pos, left = n, buf = this.buf;
    while (left > 0) {
      var off = pos & 7, take = 8 - off;
      if (take > left) take = left;
      var mask = POW2[take];
      buf[pos >>> 3] |= (v % mask) << off;
      v = Math.floor(v / mask);
      pos += take;
      left -= take;
    }
    this.pos = pos;
  };
  BitWriter.prototype.bool = function (b) { this.bits(b ? 1 : 0, 1); };
  BitWriter.prototype.bytes = function (src) {
    var n = src.length;
    this.ensure(n * 8);
    var off = this.pos & 7, idx = this.pos >>> 3, buf = this.buf;
    if (off === 0) {
      buf.set(src, idx);
    } else {
      var inv = 8 - off;
      for (var i = 0; i < n; i++) {
        var b = src[i];
        buf[idx] |= (b << off) & 0xff;
        buf[idx + 1] |= b >>> inv;
        idx++;
      }
    }
    this.pos += n * 8;
  };
  BitWriter.prototype.copyBits = function (src, nbits) {
    var full = nbits >>> 3, rem = nbits & 7;
    if (full) this.bytes(src.subarray(0, full));
    if (rem) this.bits(src[full] & ((1 << rem) - 1), rem);
  };
  BitWriter.prototype.ubitvar = function (d) {
    if (d < 16) this.bits(d, 6);
    else if (d < 256) { this.bits((d & 15) | 16, 6); this.bits(d >>> 4, 4); }
    else if (d < 4096) { this.bits((d & 15) | 32, 6); this.bits(d >>> 4, 8); }
    else { this.bits((d & 15) | 48, 6); this.bits(Math.floor(d / 16), 28); }
  };
  BitWriter.prototype.varint32 = function (d) {
    do {
      var b = d % 128;
      d = Math.floor(d / 128);
      this.bits(d > 0 ? (b | 0x80) : b, 8);
    } while (d > 0);
  };
  BitWriter.prototype.finish = function () {
    return this.buf.slice(0, (this.pos + 7) >>> 3);
  };

  function readInner(pdata, strict) {
    var br = new BitReader(pdata), out = [];
    while (br.left() > 8) {
      var t = br.ubitvar(), sz = br.varint32();
      if (sz * 8 > br.left()) {
        if (strict) throw DemoError('BAD_PACKET', 'Malformed packet');
        break;
      }
      out.push({ t: t, b: br.bytes(sz) });
    }
    return out;
  }

  function writeInner(list) {
    var size = 0, i;
    for (i = 0; i < list.length; i++) size += list[i].b.length + 8;
    var bw = new BitWriter(size + 16);
    for (i = 0; i < list.length; i++) {
      bw.ubitvar(list[i].t);
      bw.varint32(list[i].b.length);
      bw.bytes(list[i].b);
    }
    return bw.finish();
  }

  // ---------------------------------------------------------------- string tables
  function tableInfo(mb) {
    var f = parseFields(mb);
    var compressed = !!getField(f, 9);
    var sd = getField(f, 7) || new Uint8Array(0);
    if (compressed) sd = snappyDecode(sd);
    return {
      name: decodeText(getField(f, 1) || new Uint8Array(0)),
      n: getField(f, 2) || 0,
      udf: !!getField(f, 3),
      udBits: getField(f, 5) || 0,
      flags: getField(f, 6) || 0,
      compressed: compressed,
      varintBits: !!getField(f, 10),
      data: sd,
      fields: f
    };
  }

  function decodeEntries(data, n, ti) {
    var br = new BitReader(data), idx = -1, hist = [], out = [];
    for (var i = 0; i < n; i++) {
      if (br.bits(1)) idx += 1;
      else idx += br.varint32() + 2;

      var key = null;
      if (br.bits(1)) {
        if (br.bits(1)) {
          var pos = br.bits(5), ln = br.bits(5), rest = br.cstring();
          if (pos >= hist.length) key = rest;
          else {
            var h = hist[pos];
            key = concat([ln > h.length ? h : h.subarray(0, ln), rest]);
          }
        } else {
          key = br.cstring();
        }
        if (hist.length >= 32) hist.shift();
        hist.push(key);
      }

      var val = null, comp = false;
      if (br.bits(1)) {
        var nbits;
        if (ti.udf) {
          nbits = ti.udBits;
        } else {
          if (ti.flags & 1) comp = !!br.bits(1);
          nbits = (ti.varintBits ? br.ubitvar() : br.bits(17)) * 8;
        }
        if (nbits % 8 === 0) {
          val = br.bytes(nbits / 8);
        } else {
          var bw = new BitWriter(8);
          var rem = nbits;
          while (rem > 0) {
            var take = rem > 24 ? 24 : rem;
            bw.bits(br.bits(take), take);
            rem -= take;
          }
          val = bw.finish();
        }
        if (comp) val = snappyDecode(val);
      }
      out.push({ idx: idx, key: key, val: val, comp: comp });
    }
    return { entries: out, endPos: br.pos, lastIdx: idx };
  }

  function writeEntry(bw, lastIdx, e, ti) {
    if (e.idx === lastIdx + 1) {
      bw.bool(true);
    } else {
      bw.bool(false);
      bw.varint32(e.idx - lastIdx - 2);
    }

    if (e.key !== null && e.key !== undefined) {
      bw.bool(true);
      bw.bool(false);
      bw.bytes(e.key);
      bw.bits(0, 8);
    } else {
      bw.bool(false);
    }

    if (e.val !== null && e.val !== undefined) {
      bw.bool(true);
      if (ti.udf) {
        var rem = ti.udBits, k = 0;
        while (rem > 0) {
          var take = rem > 8 ? 8 : rem;
          bw.bits((e.val[k++] || 0) & ((1 << take) - 1), take);
          rem -= take;
        }
      } else {
        if (ti.flags & 1) bw.bool(false);
        if (ti.varintBits) bw.ubitvar(e.val.length);
        else bw.bits(e.val.length, 17);
        bw.bytes(e.val);
      }
    } else {
      bw.bool(false);
    }
  }

  // ---------------------------------------------------------------- utf-8
  function invalidUtf8(b) {
    var bad = null, i = 0, n = b.length;
    while (i < n) {
      var c = b[i];
      if (c < 0x80) { i++; continue; }
      var need, lo = 0x80, hi = 0xBF;
      if (c >= 0xC2 && c <= 0xDF) need = 1;
      else if (c >= 0xE0 && c <= 0xEF) {
        need = 2;
        if (c === 0xE0) lo = 0xA0;
        else if (c === 0xED) hi = 0x9F;
      } else if (c >= 0xF0 && c <= 0xF4) {
        need = 3;
        if (c === 0xF0) lo = 0x90;
        else if (c === 0xF4) hi = 0x8F;
      } else {
        (bad = bad || []).push(i);
        i++;
        continue;
      }
      var ok = i + need < n;
      for (var k = 1; ok && k <= need; k++) {
        var cc = b[i + k];
        if (k === 1 ? (cc < lo || cc > hi) : (cc < 0x80 || cc > 0xBF)) ok = false;
      }
      if (ok) i += need + 1;
      else { (bad = bad || []).push(i); i++; }
    }
    return bad;
  }

  // ---------------------------------------------------------------- container
  function detectFormat(u8) {
    if (u8.length >= 4 && u8[0] === 0x28 && u8[1] === 0xB5 && u8[2] === 0x2F && u8[3] === 0xFD) return 'zst';
    if (u8.length >= 2 && u8[0] === 0x1F && u8[1] === 0x8B) return 'gz';
    if (u8.length >= 3 && u8[0] === 0x42 && u8[1] === 0x5A && u8[2] === 0x68) return 'bz2';
    if (u8.length >= 8) {
      var dem = u8[0] === 0x50 && u8[1] === 0x42 && u8[2] === 0x44 && u8[3] === 0x45 &&
        u8[4] === 0x4D && u8[5] === 0x53 && u8[6] === 0x32 && u8[7] === 0x00;
      if (dem) return 'dem';
      var csgo = u8[0] === 0x48 && u8[1] === 0x4C && u8[2] === 0x32 && u8[3] === 0x44 &&
        u8[4] === 0x45 && u8[5] === 0x4D && u8[6] === 0x4F && u8[7] === 0x00;
      if (csgo) return 'csgo';
    }
    return 'unknown';
  }

  function indexMessages(u8, progress) {
    var msgs = [], i = 16, n = u8.length, r, lastReport = 0;
    while (i < n) {
      var s = i;
      r = readVarint(u8, i); var cmd = r[0]; i = r[1];
      r = readVarint(u8, i); var tick = r[0]; i = r[1];
      var te = i;
      r = readVarint(u8, i); var size = r[0]; i = r[1];
      if (i + size > n) {
        throw DemoError('TRUNCATED', 'The demo file is incomplete (cut off at ' + Math.round(i / n * 100) + '%)');
      }
      msgs.push({
        s: s, te: te, ps: i, pe: i + size,
        c: cmd & ~CMD_COMPRESSED,
        comp: !!(cmd & CMD_COMPRESSED),
        tick: tick === 4294967295 ? -1 : tick
      });
      i += size;
      if (i - lastReport > (8 << 20)) {
        lastReport = i;
        progress('index', i / n);
      }
    }
    return msgs;
  }

  function payloadOf(u8, m) {
    var p = u8.subarray(m.ps, m.pe);
    return m.comp ? snappyDecode(p) : p;
  }

  // ---------------------------------------------------------------- editors
  function Editors(u8, msgs) {
    this.u8 = u8;
    this.msgs = msgs;
    this.map = new Map();
  }
  Editors.prototype.get = function (idx, pre) {
    var ed = this.map.get(idx);
    if (ed) return ed;
    var m = this.msgs[idx];
    var pl = pre && pre.payload ? pre.payload : payloadOf(this.u8, m);
    ed = { idx: idx, m: m };
    if (m.c === CMD.Packet || m.c === CMD.SignonPacket) {
      ed.kind = 'packet';
      ed.fields = parseFields(pl);
      ed.inner = pre && pre.inner ? pre.inner : readInner(getField(ed.fields, 3) || new Uint8Array(0), true);
    } else if (m.c === CMD.FullPacket) {
      ed.kind = 'full';
      ed.fields = parseFields(pl);
      var pk = getField(ed.fields, 2);
      ed.pkFields = pk ? parseFields(pk) : null;
      ed.inner = pre && pre.inner ? pre.inner :
        (ed.pkFields ? readInner(getField(ed.pkFields, 3) || new Uint8Array(0), true) : null);
      var st = getField(ed.fields, 1);
      ed.stFields = st ? parseFields(st) : null;
    } else if (m.c === CMD.StringTables) {
      ed.kind = 'stringtables';
      ed.stFields = parseFields(pl);
    } else {
      throw DemoError('INTERNAL', 'No editor for command ' + m.c);
    }
    ed.innerDirty = false;
    ed.stDirty = false;
    this.map.set(idx, ed);
    return ed;
  };

  function serializeEditor(ed) {
    var payload;
    if (ed.kind === 'packet') {
      var f = ed.fields.slice();
      setField(f, 3, 2, writeInner(ed.inner));
      payload = encFields(f);
    } else if (ed.kind === 'full') {
      var ff = ed.fields.slice();
      if (ed.stDirty) setField(ff, 1, 2, encFields(ed.stFields));
      if (ed.innerDirty) {
        var pf = ed.pkFields.slice();
        setField(pf, 3, 2, writeInner(ed.inner));
        setField(ff, 2, 2, encFields(pf));
      }
      payload = encFields(ff);
    } else {
      payload = encFields(ed.stFields);
    }
    return ed.m.comp ? snappyStore(payload) : payload;
  }

  function stTables(stFields) {
    var out = [];
    if (!stFields) return out;
    for (var i = 0; i < stFields.length; i++) {
      if (stFields[i].fn !== 1) continue;
      var tf = parseFields(stFields[i].v);
      out.push({ at: i, name: decodeText(getField(tf, 1) || new Uint8Array(0)), tf: tf });
    }
    return out;
  }

  // ---------------------------------------------------------------- main
  function fixDemo(u8, opts) {
    opts = opts || {};
    var progress = opts.onProgress || function () {};
    var doText = opts.sanitizeText !== false;
    var doCrash = opts.foldTables !== false;

    var fmt = detectFormat(u8);
    if (fmt === 'csgo') throw DemoError('CSGO_DEMO', 'This is a CS:GO demo, not a CS2 demo');
    if (fmt !== 'dem') throw DemoError('NOT_DEMO', 'Not a CS2 demo file');
    if (u8.length < 16) throw DemoError('TRUNCATED', 'File too small');

    var hdrFileInfo = readInt32LE(u8, 8), hdrSpawn = readInt32LE(u8, 12);
    progress('index', 0);
    var msgs = indexMessages(u8, progress);
    progress('index', 1);

    var report = {
      version: VERSION,
      inSize: u8.length,
      messages: msgs.length,
      header: {},
      crashFix: { needed: false, applied: false, tables: [], fullPacketTrimmed: [] },
      textFix: { items: [] },
      warnings: []
    };

    var classNames = {};
    for (var k = 0; k < msgs.length; k++) {
      var m = msgs[k];
      if (m.c === CMD.FileHeader) {
        var hf = parseFields(payloadOf(u8, m));
        report.header.map = decodeText(getField(hf, 5) || null);
        report.header.server = decodeText(getField(hf, 3) || null);
        report.header.protocol = getField(hf, 2);
        report.header.build = getField(hf, 13);
      } else if (m.c === CMD.ClassInfo) {
        var cf = parseFields(payloadOf(u8, m));
        for (var c = 0; c < cf.length; c++) {
          if (cf[c].fn !== 1) continue;
          var cl = parseFields(cf[c].v);
          classNames[getField(cl, 1)] = decodeText(getField(cl, 2) || new Uint8Array(0));
        }
      } else if (m.c === CMD.Packet) {
        break;
      }
    }
    var lastMsg = msgs[msgs.length - 1];
    if (lastMsg && lastMsg.c === CMD.FileInfo) {
      var fi = parseFields(payloadOf(u8, lastMsg));
      var pt = getField(fi, 1);
      if (pt && pt.length >= 4) {
        var dv = new DataView(pt.buffer, pt.byteOffset, 4);
        report.header.seconds = dv.getFloat32(0, true);
      }
      report.header.ticks = getField(fi, 2);
    }

    var editors = new Editors(u8, msgs);

    // ---- pass 1: repair invalid UTF-8 inside game-event strings
    if (doText) {
      var eventNames = {}, eventKeys = {};
      var lastP = 0;
      for (var mi = 0; mi < msgs.length; mi++) {
        var mm = msgs[mi];
        if (mm.c !== CMD.Packet && mm.c !== CMD.SignonPacket && mm.c !== CMD.FullPacket) continue;
        if (mi - lastP > 2000) { lastP = mi; progress('scan', mi / msgs.length); }
        var pl = payloadOf(u8, mm), pdata;
        if (mm.c === CMD.FullPacket) {
          var pk = getField(parseFields(pl), 2);
          if (!pk) continue;
          pdata = getField(parseFields(pk), 3);
        } else {
          pdata = getField(parseFields(pl), 3);
        }
        if (!pdata) continue;

        var br = new BitReader(pdata), list = [];
        while (br.left() > 8) {
          var t = br.ubitvar(), sz = br.varint32();
          if (sz * 8 > br.left()) break;
          if (t === GE_GAME_EVENT || t === GE_GAME_EVENT_LIST) {
            list.push({ t: t, b: br.bytes(sz) });
          } else {
            list.push({ t: t, start: br.pos, sz: sz });
            br.skipBytes(sz);
          }
        }

        var fixedHere = false;
        for (var li = 0; li < list.length; li++) {
          var im = list[li];
          if (im.t === GE_GAME_EVENT_LIST) {
            var gl = parseFields(im.b);
            for (var g = 0; g < gl.length; g++) {
              if (gl[g].fn !== 1) continue;
              var d = parseFields(gl[g].v), keys = [];
              for (var q = 0; q < d.length; q++) {
                if (d[q].fn === 3) {
                  var kf = parseFields(d[q].v);
                  keys.push(decodeText(getField(kf, 2) || new Uint8Array(0)));
                }
              }
              var id = getField(d, 1) || 0;
              eventNames[id] = decodeText(getField(d, 2) || new Uint8Array(0));
              eventKeys[id] = keys;
            }
          } else if (im.t === GE_GAME_EVENT) {
            var ef = parseFields(im.b), eid = getField(ef, 2) || 0, keyNo = 0;
            for (var e = 0; e < ef.length; e++) {
              var fld = ef[e];
              if (fld.fn === 1 && fld.wt === 2) {
                var badName = invalidUtf8(fld.v);
                if (badName) {
                  var bn = toHex(fld.v);
                  for (var z = 0; z < badName.length; z++) fld.v[badName[z]] = 0x3F;
                  fixedHere = true;
                  report.textFix.items.push({
                    tick: mm.tick,
                    event: eventNames[eid] || ('event ' + eid),
                    key: '(name)',
                    before: bn,
                    after: decodeText(fld.v)
                  });
                }
              } else if (fld.fn === 3 && fld.wt === 2) {
                var kfs = parseFields(fld.v);
                for (var x = 0; x < kfs.length; x++) {
                  if (kfs[x].fn !== 2 || kfs[x].wt !== 2) continue;
                  var bad = invalidUtf8(kfs[x].v);
                  if (!bad) continue;
                  var before = toHex(kfs[x].v);
                  for (var y = 0; y < bad.length; y++) kfs[x].v[bad[y]] = 0x3F;
                  fixedHere = true;
                  report.textFix.items.push({
                    tick: mm.tick,
                    event: eventNames[eid] || ('event ' + eid),
                    key: (eventKeys[eid] && eventKeys[eid][keyNo]) || ('key ' + keyNo),
                    before: before,
                    after: decodeText(kfs[x].v)
                  });
                }
                keyNo++;
              }
            }
          }
        }

        if (fixedHere) {
          var full = [];
          for (var fj = 0; fj < list.length; fj++) {
            var it = list[fj];
            if (it.b) {
              full.push({ t: it.t, b: it.b });
            } else {
              var sub = new BitReader(pdata);
              sub.pos = it.start;
              full.push({ t: it.t, b: sub.bytes(it.sz) });
            }
          }
          var ed = editors.get(mi, { payload: pl, inner: full });
          ed.innerDirty = true;
        }
      }
      progress('scan', 1);
    }

    // ---- pass 2: move the first-packet baselines into the signon tables
    if (doCrash) {
      progress('fix', 0);
      try {
      var tables = [], snapIdx = -1, firstPkt = -1, firstFull = -1;

      for (var si = 0; si < msgs.length; si++) {
        var sm = msgs[si];
        if (sm.c === CMD.Packet) { firstPkt = si; break; }
        if (sm.c === CMD.StringTables && snapIdx < 0) snapIdx = si;
        if (sm.c !== CMD.SignonPacket) continue;
        var spl = payloadOf(u8, sm);
        var sd = getField(parseFields(spl), 3);
        if (!sd) continue;
        var sinner = readInner(sd, false);
        for (var sj = 0; sj < sinner.length; sj++) {
          if (sinner[sj].t === SVC_CLEAR_ALL_STRING_TABLES) {
            tables = [];
          } else if (sinner[sj].t === SVC_CREATE_STRING_TABLE) {
            var info = tableInfo(sinner[sj].b);
            info.loc = { msg: si, inner: sj };
            info.id = tables.length;
            tables.push(info);
          }
        }
      }

      if (firstPkt >= 0) {
        for (var fk = firstPkt + 1; fk < msgs.length; fk++) {
          if (msgs[fk].c === CMD.FullPacket) {
            if (msgs[fk].tick === msgs[firstPkt].tick) firstFull = fk;
            break;
          }
          if (msgs[fk].tick > msgs[firstPkt].tick) break;
        }
      }

      var byName = {};
      tables.forEach(function (ti) { byName[ti.name] = ti; });

      var updates = {};
      if (firstPkt >= 0) {
        var fed = editors.map.get(firstPkt);
        var finner = fed ? fed.inner :
          readInner(getField(parseFields(payloadOf(u8, msgs[firstPkt])), 3) || new Uint8Array(0), false);
        for (var ui = 0; ui < finner.length; ui++) {
          if (finner[ui].t !== SVC_UPDATE_STRING_TABLE) continue;
          var uf = parseFields(finner[ui].b);
          var tid = getField(uf, 1) || 0, ti2 = tables[tid];
          if (!ti2 || FOLD_TABLES.indexOf(ti2.name) < 0) continue;
          var dec = decodeEntries(getField(uf, 3) || new Uint8Array(0), getField(uf, 2) || 0, ti2);
          updates[ti2.name] = (updates[ti2.name] || []).concat(dec.entries);
        }
      }

      report.crashFix.needed = !!(updates.instancebaseline && updates.instancebaseline.length);
      report.crashFix.firstPacketTick = firstPkt >= 0 ? msgs[firstPkt].tick : null;

      if (report.crashFix.needed) {
        var plan = [], abort = null;

        FOLD_TABLES.forEach(function (name) {
          if (!updates[name] || abort) return;
          var ti = byName[name];
          if (!ti) { abort = 'table ' + name + ' missing from signon'; return; }

          var cur = decodeEntries(ti.data, ti.n, ti);
          var curEntries = cur.entries.slice();
          var appended = [], replaced = [], identical = [];

          for (var i = 0; i < curEntries.length; i++) {
            if (curEntries[i].idx !== i) { abort = 'gaps in signon table ' + name; return; }
          }

          for (var u = 0; u < updates[name].length; u++) {
            var ue = updates[name][u];
            if (ue.idx < ti.n) {
              var ce = curEntries[ue.idx];
              var keyOk = !ue.key || bytesEqual(ue.key, ce.key);
              var valOk = !ue.val || bytesEqual(ue.val, ce.val);
              if (keyOk && valOk) {
                identical.push(ue.idx);
              } else {
                curEntries[ue.idx] = {
                  idx: ue.idx,
                  key: ue.key || ce.key,
                  val: ue.val || ce.val
                };
                replaced.push(ue.idx);
              }
            } else {
              var exp = ti.n + appended.length;
              if (ue.idx !== exp || !ue.key) { abort = 'irregular update to ' + name; return; }
              appended.push({ idx: ue.idx, key: ue.key, val: ue.val });
            }
          }
          if (abort) return;

          var bw = new BitWriter(ti.data.length + 1024), last;
          if (replaced.length === 0) {
            bw.copyBits(ti.data, cur.endPos);
            last = cur.lastIdx;
          } else {
            last = -1;
            for (var r = 0; r < curEntries.length; r++) {
              writeEntry(bw, last, curEntries[r], ti);
              last = curEntries[r].idx;
            }
          }
          for (var a = 0; a < appended.length; a++) {
            writeEntry(bw, last, appended[a], ti);
            last = appended[a].idx;
          }

          var newData = bw.finish(), newN = ti.n + appended.length;
          var chk = decodeEntries(newData, newN, ti).entries;
          var want = curEntries.concat(appended);
          for (var w = 0; w < want.length; w++) {
            if (chk[w].idx !== want[w].idx || !bytesEqual(chk[w].key, want[w].key) || !bytesEqual(chk[w].val, want[w].val)) {
              abort = 'self-check failed for ' + name;
              return;
            }
          }

          plan.push({
            ti: ti, newData: newData, newN: newN, appended: appended,
            replaced: replaced, identical: identical, curEntries: curEntries
          });
        });

        if (abort) {
          report.warnings.push('crash fix skipped: ' + abort);
        } else {
          plan.forEach(function (pt) {
            var ti = pt.ti;
            if (pt.appended.length || pt.replaced.length) {
              var f = ti.fields.slice();
              setField(f, 2, 0, pt.newN);
              setField(f, 7, 2, ti.compressed ? snappyStore(pt.newData) : pt.newData);
              if (ti.compressed) setField(f, 8, 0, pt.newData.length);

              var sed = editors.get(ti.loc.msg);
              sed.inner[ti.loc.inner] = { t: SVC_CREATE_STRING_TABLE, b: encFields(f) };
              sed.innerDirty = true;

              if (snapIdx >= 0) {
                var ned = editors.get(snapIdx);
                stTables(ned.stFields).forEach(function (tb) {
                  if (tb.name !== ti.name) return;
                  var itemPos = [];
                  tb.tf.forEach(function (fld, i) { if (fld.fn === 2) itemPos.push(i); });

                  pt.replaced.forEach(function (ri) {
                    var e = pt.curEntries[ri];
                    if (ri < itemPos.length) {
                      tb.tf[itemPos[ri]] = {
                        fn: 2, wt: 2, raw: null,
                        v: encFields([
                          { fn: 1, wt: 2, v: e.key },
                          { fn: 2, wt: 2, v: e.val || new Uint8Array(0) }
                        ])
                      };
                    }
                  });

                  var insertAt = itemPos.length ? itemPos[itemPos.length - 1] + 1 : tb.tf.length;
                  var items = pt.appended.map(function (e) {
                    return {
                      fn: 2, wt: 2, raw: null,
                      v: encFields([
                        { fn: 1, wt: 2, v: e.key },
                        { fn: 2, wt: 2, v: e.val || new Uint8Array(0) }
                      ])
                    };
                  });
                  var ntf = tb.tf.slice(0, insertAt).concat(items, tb.tf.slice(insertAt));
                  ned.stFields[tb.at] = { fn: 1, wt: 2, v: encFields(ntf), raw: null };
                  ned.stDirty = true;
                });
              }
            }

            report.crashFix.tables.push({
              name: ti.name,
              before: ti.n,
              after: pt.newN,
              added: pt.appended.map(function (e) {
                var key = decodeText(e.key);
                return {
                  index: e.idx,
                  key: key,
                  className: ti.name === 'instancebaseline' ? (classNames[parseInt(key, 10)] || null) : null
                };
              }),
              replaced: pt.replaced,
              duplicatesRemoved: pt.identical.length
            });
          });

          var ids = plan.map(function (pt) { return pt.ti.id; });
          var ped = editors.get(firstPkt);
          ped.inner = ped.inner.filter(function (im2) {
            return !(im2.t === SVC_UPDATE_STRING_TABLE && ids.indexOf(getField(parseFields(im2.b), 1) || 0) >= 0);
          });
          ped.innerDirty = true;

          if (firstFull >= 0) {
            var fed2 = editors.get(firstFull);
            if (fed2.stFields) {
              var names = plan.map(function (pt) { return pt.ti.name; });
              var keep = [];
              fed2.stFields.forEach(function (fld) {
                if (fld.fn === 1) {
                  var nm = decodeText(getField(parseFields(fld.v), 1) || new Uint8Array(0));
                  if (names.indexOf(nm) >= 0) {
                    report.crashFix.fullPacketTrimmed.push(nm);
                    return;
                  }
                }
                keep.push(fld);
              });
              fed2.stFields = keep;
              fed2.stDirty = true;
            }
          }

          report.crashFix.applied = true;
        }
      }
      } catch (e) {
        report.warnings.push('crash fix skipped: ' + (e && e.message ? e.message : e));
      }
      progress('fix', 1);
    }

    if (editors.map.size === 0) {
      report.changed = false;
      report.outSize = u8.length;
      return { changed: false, report: report };
    }

    // ---- emit
    progress('write', 0);
    var parts = [new Uint8Array(16)], outPos = 16, runStart = -1;
    var newFileInfo = -1, newSpawn = -1, fiCmd = -1, spCmd = -1, lastW = 0;
    var frames = [];

    for (var oi = 0; oi < msgs.length; oi++) {
      var om = msgs[oi];
      if (om.s === hdrFileInfo) newFileInfo = outPos;
      if (om.s === hdrSpawn) newSpawn = outPos;
      if (om.c === CMD.FileInfo) fiCmd = outPos;
      if (om.c === CMD.SpawnGroups) spCmd = outPos;

      var oed = editors.map.get(oi);
      if (!oed) {
        if (runStart < 0) runStart = om.s;
        frames.push({ s: om.s, ps: om.ps, pe: om.pe, out: outPos, changed: false });
        outPos += om.pe - om.s;
        continue;
      }

      if (runStart >= 0) {
        parts.push(u8.subarray(runStart, om.s));
        runStart = -1;
      }

      var np = serializeEditor(oed);
      var hdr = concat([u8.subarray(om.s, om.te), varintBytes(np.length)]);
      parts.push(hdr, np);
      frames.push({
        s: om.s, ps: om.ps, pe: om.pe, out: outPos, changed: true,
        newPs: outPos + hdr.length
      });
      outPos += hdr.length + np.length;

      if (oi - lastW > 5000) { lastW = oi; progress('write', oi / msgs.length); }
    }
    if (runStart >= 0) parts.push(u8.subarray(runStart, u8.length));

    function mapOffset(off) {
      for (var i = 0; i < frames.length; i++) {
        var fr = frames[i];
        if (off < fr.s || off >= fr.pe) continue;
        if (!fr.changed) return fr.out + (off - fr.s);
        if (off === fr.s) return fr.out;
        if (off === fr.ps) return fr.newPs;
        return -1;
      }
      return -1;
    }

    var mappedFi = mapOffset(hdrFileInfo);
    var mappedSp = mapOffset(hdrSpawn);
    if (mappedFi < 0) mappedFi = hdrFileInfo ? fiCmd : 0;
    if (mappedSp < 0) mappedSp = hdrSpawn ? spCmd : 0;
    parts[0] = concat([u8.subarray(0, 8), int32LE(mappedFi), int32LE(mappedSp)]);

    progress('write', 1);

    report.changed = true;
    report.modifiedMessages = editors.map.size;
    report.outSize = outPos;
    return { changed: true, parts: parts, size: outPos, report: report };
  }

  return {
    VERSION: VERSION,
    fixDemo: fixDemo,
    detectFormat: detectFormat,
    _internal: {
      snappyDecode: snappyDecode,
      snappyStore: snappyStore,
      invalidUtf8: invalidUtf8,
      BitReader: BitReader,
      BitWriter: BitWriter,
      readInner: readInner,
      writeInner: writeInner,
      tableInfo: tableInfo,
      decodeEntries: decodeEntries,
      writeEntry: writeEntry,
      parseFields: parseFields,
      encFields: encFields,
      getField: getField,
      varintBytes: varintBytes
    }
  };
}));
