// storage.js — Progress storage + statistics for the HSC Syllabus Tracker
// Works with window.SYLLABUS_DATA (see physics.js). Safe in sandboxed previews
// where localStorage is blocked: it falls back to in-memory storage.

(function (global) {
  'use strict';

  function createSafeStorage() {
    try {
      var testKey = '__hsc_storage_test__';
      global.localStorage.setItem(testKey, '1');
      global.localStorage.removeItem(testKey);
      return {
        persistent: true,
        get: function (k) { return global.localStorage.getItem(k); },
        set: function (k, v) { global.localStorage.setItem(k, v); }
      };
    } catch (err) {
      var mem = {};
      return {
        persistent: false,
        get: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        set: function (k, v) { mem[k] = String(v); }
      };
    }
  }

  // Set to true to split on EVERY comma (even inside brackets, like the old behaviour).
  // false keeps things like "(ম্যাজিক, ল্যামিডাইকা)" together as one topic.
  var SPLIT_INSIDE_BRACKETS = false;

  function splitTitle(title) {
    var str = String(title);
    var parts = [];
    var cur = '';
    var depth = 0;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charAt(i);
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) depth--;
      var isComma = ch === ',' || ch === '\uFF0C' || ch === '\u060C' || ch === '\u3001';
      if (isComma && (SPLIT_INSIDE_BRACKETS || depth === 0)) {
        parts.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    parts.push(cur);
    return parts.map(function (p) { return p.trim(); }).filter(function (p) { return p.length > 0; });
  }

  class SyllabusManager {
    constructor(storageKey) {
      this.storageKey = storageKey || 'hsc_syllabus_meta_v2';
      this.storage = createSafeStorage();
      this.data = { items: {}, customTopics: {} };
      this.load();
    }

    /* ---------- persistence ---------- */
    load() {
      try {
        var raw = this.storage.get(this.storageKey);
        var parsed = raw ? JSON.parse(raw) : null;
        this.data = {
          items: (parsed && parsed.items) || {},
          customTopics: (parsed && parsed.customTopics) || {}
        };
      } catch (err) {
        console.error('Failed to load progress:', err);
        this.data = { items: {}, customTopics: {} };
      }
    }

    save() {
      try {
        this.storage.set(this.storageKey, JSON.stringify(this.data));
      } catch (err) {
        console.error('Failed to save progress:', err);
      }
    }

    /* ---------- syllabus data access ---------- */
    // Accepts several data shapes and converts them to one standard shape:
    //   papers: [ {chapters:[...]}, ... ]            (array of papers)
    //   papers: { "1": [chapters...], "2": [...] }   (object keyed by paper number)
    //   an array of papers, or {chapters:[...]} for a single-paper subject.
    // Lectures may be called lectures / topics / subtopics / lessons, or be plain strings.
    _normalize(subId, raw) {
      var rawPapers;
      if (Array.isArray(raw)) {
        rawPapers = raw;
      } else if (raw && Array.isArray(raw.papers)) {
        rawPapers = raw.papers;
      } else if (raw && raw.papers && typeof raw.papers === 'object') {
        rawPapers = Object.keys(raw.papers)
          .sort(function (x, y) { return Number(x) - Number(y); })
          .map(function (k) { return raw.papers[k]; });
      } else if (raw && Array.isArray(raw.chapters)) {
        rawPapers = [{ chapters: raw.chapters }];
      } else {
        return null;
      }

      // Physics keeps its original ids (so saved progress stays valid);
      // other subjects get a prefix so ids never collide between subjects.
      var ns = subId === 'physics' ? '' : subId + ':';
      var self = this;

      return {
        id: subId,
        name: (raw && raw.name) || subId,
        papers: rawPapers.map(function (paper, pi) {
          var chapters = Array.isArray(paper) ? paper
            : (paper && Array.isArray(paper.chapters)) ? paper.chapters : [];
          return {
            paperName: (!Array.isArray(paper) && paper && (paper.paperName || paper.name || paper.title)) || '',
            chapters: chapters.map(function (ch, ci) {
              var chId = ch.id || ('p' + (pi + 1) + '_c' + (ci + 1));
              var rawLecs = ch.lectures || ch.topics || ch.subtopics || ch.lessons || [];
              var lectures = rawLecs.map(function (l, li) {
                var isStr = typeof l === 'string';
                return {
                  id: ns + ((!isStr && l.id) || (chId + '_l' + (li + 1))),
                  title: isStr ? l : (l.title || l.name || ('লেকচার ' + (li + 1)))
                };
              });
              return {
                id: ns + chId,
                title: ch.title || ch.name || ('অধ্যায় ' + (ci + 1)),
                lectures: lectures,
                // comma-separated lecture titles are broken down into separate topics
                baseTopics: self._breakDown(lectures)
              };
            })
          };
        })
      };
    }

    // Splits "A, B, C" lecture titles into separate topics (the "breakdown").
    _breakDown(lectures) {
      var out = [];
      lectures.forEach(function (l) {
        var parts = splitTitle(l.title);
        if (parts.length <= 1) {
          out.push({ id: l.id, title: parts[0] || l.title, custom: false });
        } else {
          parts.forEach(function (p, idx) {
            out.push({ id: l.id + '_sub_' + idx, title: p, custom: false });
          });
        }
      });
      return out;
    }

    getSubject(subId) {
      var raw = global.SYLLABUS_DATA && global.SYLLABUS_DATA[subId];
      if (!raw) return null;
      this._cache = this._cache || {};
      var c = this._cache[subId];
      if (!c || c.raw !== raw) {
        c = this._cache[subId] = { raw: raw, norm: this._normalize(subId, raw) };
      }
      return c.norm;
    }

    hasSubject(subId) {
      return !!this.getSubject(subId);
    }

    getChapters(subId, paperNum) {
      var subject = this.getSubject(subId);
      var paper = subject && subject.papers && subject.papers[paperNum - 1];
      return paper && Array.isArray(paper.chapters) ? paper.chapters : [];
    }

    // Broken-down topics from the data file + user-added sub-topics, all with stable ids.
    // Every count / progress calculation uses this same list.
    getTopics(chapter) {
      var base = chapter.baseTopics || this._breakDown(chapter.lectures || []);
      var extra = (this.data.customTopics[chapter.id] || []).map(function (t) {
        return { id: t.id, title: t.title, custom: true };
      });
      return base.concat(extra);
    }

    /* ---------- progress items ---------- */
    getItem(id) {
      return this.data.items[id] || null;
    }

    isDone(id) {
      var it = this.data.items[id];
      return !!(it && it.completed);
    }

    // A chapter is done when all its topics are done (or itself, if it has none)
    isChapterDone(chapter) {
      var topics = this.getTopics(chapter);
      if (topics.length === 0) return this.isDone(chapter.id);
      var self = this;
      return topics.every(function (t) { return self.isDone(t.id); });
    }

    countDoneTopics(chapter) {
      var self = this;
      return this.getTopics(chapter).filter(function (t) { return self.isDone(t.id); }).length;
    }

    _stamp(details) {
      return {
        completed: true,
        quality: details.quality || 'Good',
        book: !!details.book,
        mcq: !!details.mcq,
        cq: !!details.cq,
        updatedAt: new Date().toISOString()
      };
    }

    setItem(id, details) {
      this.data.items[id] = this._stamp(details);
      this.save();
    }

    clearItem(id) {
      delete this.data.items[id];
      this.save();
    }

    // Marking a whole chapter applies the details to every topic not already done
    setChapter(chapter, details) {
      var self = this;
      this.getTopics(chapter).forEach(function (t) {
        if (!self.isDone(t.id)) self.data.items[t.id] = self._stamp(details);
      });
      this.data.items[chapter.id] = this._stamp(details);
      this.save();
    }

    resetChapter(chapter) {
      var self = this;
      this.getTopics(chapter).forEach(function (t) { delete self.data.items[t.id]; });
      delete this.data.items[chapter.id];
      this.save();
    }

    addCustomTopic(chapter, title) {
      var list = this.data.customTopics[chapter.id] || (this.data.customTopics[chapter.id] = []);
      var id = chapter.id + '_x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      list.push({ id: id, title: title });
      this.save();
      return id;
    }

    /* ---------- statistics ---------- */
    getSubjectStats(subId) {
      var subject = this.getSubject(subId);
      if (!subject) return { hasData: false, total: 0, completed: 0, pct: 0 };

      var total = 0;
      var completed = 0;
      var self = this;

      (subject.papers || []).forEach(function (paper) {
        (paper.chapters || []).forEach(function (chapter) {
          var topics = self.getTopics(chapter);
          if (topics.length === 0) {
            total++;
            if (self.isDone(chapter.id)) completed++;
          } else {
            topics.forEach(function (t) {
              total++;
              if (self.isDone(t.id)) completed++;
            });
          }
        });
      });

      return {
        hasData: true,
        total: total,
        completed: completed,
        pct: total > 0 ? Math.round((completed / total) * 100) : 0
      };
    }

    // Only subjects that actually have data count toward the overall percentage
    getOverallStats(subIds) {
      var total = 0;
      var completed = 0;
      var self = this;
      subIds.forEach(function (id) {
        var s = self.getSubjectStats(id);
        if (s.hasData) {
          total += s.total;
          completed += s.completed;
        }
      });
      return {
        total: total,
        completed: completed,
        pct: total > 0 ? Math.round((completed / total) * 100) : 0
      };
    }
  }

  global.SyllabusManager = SyllabusManager;
})(window);
