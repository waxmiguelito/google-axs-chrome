// Copyright 2012 Google Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Manages navigation within a page.
 * This unifies navigation by the DOM walker and by WebKit selection.
 * NOTE: the purpose of this class is only to hold state
 * and delegate all of its functionality to mostly stateless classes that
 * are easy to test.
 *
 * @author clchen@google.com (Charles L. Chen)
 */


goog.provide('cvox.NavigationManager');

goog.require('cvox.ActiveIndicator');
goog.require('cvox.ChromeVox');
goog.require('cvox.ChromeVoxEventSuspender');
goog.require('cvox.CursorSelection');
goog.require('cvox.DescriptionUtil');
goog.require('cvox.DomUtil');
goog.require('cvox.Focuser');
goog.require('cvox.Interframe');
goog.require('cvox.NavDescription');
goog.require('cvox.NavigationHistory');
goog.require('cvox.NavigationShifter');
goog.require('cvox.NavigationSpeaker');
goog.require('cvox.PageSelection');
goog.require('cvox.SelectionUtil');
goog.require('cvox.WalkerDecorator');
goog.require('cvox.Widget');


/**
 * @constructor
 */
cvox.NavigationManager = function() {
  this.addInterframeListener_();

  this.reset();
};

/**
 * Stores state variables in a provided object.
 *
 * @param {Object} store The object.
 */
cvox.NavigationManager.prototype.storeOn = function(store) {
  store['reversed'] = this.isReversed();
  this.navShifter_.storeOn(store);
};

/**
 * Updates the object with state variables from an earlier storeOn call.
 *
 * @param {Object} store The object.
 */
cvox.NavigationManager.prototype.readFrom = function(store) {
  this.curSel_.setReversed(store['reversed']);
  this.navShifter_.readFrom(store);
};

/**
 * Resets the navigation manager to the top of the page.
 */
cvox.NavigationManager.prototype.reset = function() {
  /**
   * @type {!cvox.NavigationSpeaker}
   * @private
   */
  this.navSpeaker_ = new cvox.NavigationSpeaker();

  /**
   * @type {!cvox.NavigationShifter}
   * @private
   */
  this.navShifter_ = new cvox.NavigationShifter();


  // NOTE(deboer): document.activeElement can not be null (c.f.
  // https://developer.mozilla.org/en-US/docs/DOM/document.activeElement)
  // Instead, if there is no active element, activeElement is set to
  // document.body.
  /**
   * If there is an activeElement, use it.  Otherwise, sync to the page
   * beginning.
   * @type {!cvox.CursorSelection}
   * @private
   */
  this.curSel_ = document.activeElement != document.body ?
      (/** @type {!cvox.CursorSelection} **/
      cvox.CursorSelection.fromNode(document.activeElement)) :
      this.navShifter_.syncToPageBeginning();

  /**
   * @type {!cvox.CursorSelection}
   * @private
   */
  this.prevSel_ = this.curSel_.clone();

  /**
   * Keeps track of whether we have skipped while "reading from here"
   * so that we can insert an earcon.
   * @type {boolean}
   * @private
   */
  this.skipped_ = false;

  /**
   * Keeps track of whether we have recovered from dropped focus
   * so that we can insert an earcon.
   * @type {boolean}
   * @private
   */
  this.recovered_ = false;

  // TODO(stoarca): Make private when external calls are gone.
  /**
   * True if in "reading from here" mode.
   * @type {boolean}
   */
  this.keepReading_ = false;

  /**
   * True if we are at the edge of a table and we already tried to go past it.
   * @type {boolean}
   * @private
   */
  this.bumpedEdge_ = false;

  /**
   * True if we are at the end of the page and we wrap around.
   * @type {boolean}
   * @private
   */
  this.pageEnd_ = false;

  /**
   * True if we want to ignore iframes no matter what.
   * @type {boolean}
   * @private
   */
  this.ignoreIframesNoMatterWhat_ = false;

  /**
   * @type {cvox.PageSelection}
   * @private
   */
  this.pageSel_ = null;

  // TODO(stoarca): This seems goofy. Why are we doing this?
  if (this.activeIndicator) {
    this.activeIndicator.removeFromDom();
  }
  this.activeIndicator = new cvox.ActiveIndicator();

  /**
   * Makes sure focus doesn't get lost.
   * @type {!cvox.NavigationHistory}
   * @private
   */
  this.navigationHistory_ = new cvox.NavigationHistory();

  /** @type {boolean} */
  this.disableNavigationHistory_ = false;

  this.iframeIdMap = {};
  this.nextIframeId = 1;

  // Only sync if the activeElement is not document.body; which is shorthand for
  // 'no selection'.  Currently the walkers don't deal with the no selection
  // case -- and it is not clear that they should.
  if (document.activeElement != document.body) {
    this.sync();
  }
};


/**
 * Determines if we are navigating from a valid node. If not, ask navigation
 * history for an acceptable restart point and go there.
 * @param {function(Node)} opt_predicate A function that takes in a node and
 *     returns true if it is a valid recovery candidate.
 * @return {boolean} True if we should continue navigation normally.
 */
cvox.NavigationManager.prototype.resolve = function(opt_predicate) {
  if (this.disableNavigationHistory_) {
    return true;
  }
  var current = this.getCurrentNode();
  if (!this.navigationHistory_.becomeInvalid(current)) {
    return true;
  }

  // Our current node was invalid. Revert to history.
  var revert = this.navigationHistory_.revert(opt_predicate);

  // If the history is empty, revert.current will be null.  In that case,
  // it is best to continue navigationg normally.
  if (!revert.current) {
    return true;
  }

  // Convert to selections.
  var newSel = cvox.CursorSelection.fromNode(revert.current);
  var context = cvox.CursorSelection.fromNode(revert.previous);

  // Default to document body if selections are null.
  newSel = newSel || cvox.CursorSelection.fromBody();
  context = context || cvox.CursorSelection.fromBody();
  newSel.setReversed(this.isReversed());

  this.updateSel(newSel, context);
  this.recovered_ = true;
  return false;
};


/**
 * Disables NavigationHistory.
 */
cvox.NavigationManager.prototype.disableNavigationHistory = function() {
  this.disableNavigationHistory_ = true;
};


/**
 * Enables NavigationHistory.
 */
cvox.NavigationManager.prototype.enableNavigationHistory = function() {
  this.disableNavigationHistory_ = false;
};


/**
 * Delegates to NavigationShifter with current page state.
 * @param {boolean=} iframes Jump in and out of iframes if true. Default false.
 * @return {boolean} False if end of document has been reached.
 * @private
 */
cvox.NavigationManager.prototype.next_ = function(iframes) {
  if (this.tryBoundaries_(this.navShifter_.next(this.curSel_), iframes)) {
    // TODO(dtseng): An observer interface would help to keep logic like this
    // to a minimum.
    this.pageSel_ && this.pageSel_.extend(this.curSel_);
    return true;
  }
  return false;
};


/**
 * Delegates to NavigationShifter with current page state.
 * @param {function(Array.<Node>)} predicate A function taking an array
 *     of unique ancestor nodes as a parameter and returning a desired node.
 *     It returns null if that node can't be found.
 * @return {boolean} True if a match was found.
 */
cvox.NavigationManager.prototype.findNext = function(predicate) {
  this.resolve();
  var ret = this.navShifter_.findNext(this.curSel_, predicate);
  if (ret) {
    return this.tryTable_(ret);
  }
  return false;
};


/**
 * Delegates to NavigationShifter with current page state.
 * @return {boolean} True if some action that could be taken exists.
 */
cvox.NavigationManager.prototype.act = function() {
  return this.navShifter_.act(this.curSel_);
};


/**
 * Delegates to NavigationShifter with current page state.
 */
cvox.NavigationManager.prototype.sync = function() {
  this.resolve();
  var ret = this.navShifter_.sync(this.curSel_);
  if (ret) {
    this.curSel_ = ret;
  }
};

/**
 * Sync's all possible cursors:
 * - focus
 * - ActiveIndicator
 * - CursorSelection
 */
cvox.NavigationManager.prototype.syncAll = function() {
  this.sync();
  this.setFocus();
  this.updateIndicator();
};


/**
 * Clears a DOM selection made via a CursorSelection.
 */
cvox.NavigationManager.prototype.clearPageSel = function() {
  this.pageSel_ = null;
};


/**
 * Begins or finishes a DOM selection at the current CursorSelection in the
 * document.
 */
cvox.NavigationManager.prototype.togglePageSel = function() {
  this.pageSel_ = this.pageSel_ ? null : new cvox.PageSelection(this.curSel_);
  return !!this.pageSel_;
};


// TODO(stoarca): getDiscription is split awkwardly between here and the
// walkers. The walkers should have getBaseDescription() which requires
// very little context, and then this method should tack on everything
// which requires any extensive knowledge.
/**
 * Delegates to NavigationShifter with the current page state.
 * @return {Array.<cvox.NavDescription>} The summary of the current position.
 */
cvox.NavigationManager.prototype.getDescription = function() {
  var desc = this.pageSel_ ? this.pageSel_.getDescription(
          this.navShifter_, this.prevSel_, this.curSel_) :
      this.navShifter_.getDescription(this.prevSel_, this.curSel_);
  var earcons = [];

  if (this.skipped_) {
    earcons.push(cvox.AbstractEarcons.PARAGRAPH_BREAK);
    this.skipped_ = false;
  }
  if (this.recovered_) {
    earcons.push(cvox.AbstractEarcons.FONT_CHANGE);
    this.recovered_ = false;
  }
  if (this.bumpedEdge_) {
    earcons.push(cvox.AbstractEarcons.OBJECT_EXIT);
  }
  if (this.pageEnd_) {
    earcons.push(cvox.AbstractEarcons.WRAP);
    this.pageEnd_ = false;
  }
  if (earcons.length > 0 && desc.length > 0) {
    earcons.forEach(function(earcon) {
        desc[0].pushEarcon(earcon);
    });
  }
  return desc;
};


/**
 * Returns the current navigation strategy.
 *
 * @return {string} The name of the strategy used.
 */
cvox.NavigationManager.prototype.getGranularityMsg = function() {
  return this.navShifter_.getGranularityMsg();
};


/**
 * Traverses to the first cell of the current table.
 * @return {boolean} Whether or not the traversal was successful. False implies
 * that we are not currently inside a table.
 */
cvox.NavigationManager.prototype.goToFirstCell = function() {
  return this.updateSel(this.navShifter_.goToFirstCell(this.curSel_));
};


/**
 * Traverses to the last cell of the current table.
 * @return {boolean} Whether or not the traversal was successful. False implies
 * that we are not currently inside a table.
 */
cvox.NavigationManager.prototype.goToLastCell = function() {
  return this.updateSel(this.navShifter_.goToLastCell(this.curSel_));
};


/**
 * Traverses to the first cell of the current row of the current table.
 * @return {boolean} Whether or not the traversal was successful. False implies
 * that we are not currently inside a table.
 */
cvox.NavigationManager.prototype.goToRowFirstCell = function() {
  return this.updateSel(this.navShifter_.goToRowFirstCell(this.curSel_));
};


/**
 * Traverses to the last cell of the current row of the current table.
 * @return {boolean} Whether or not the traversal was successful. False implies
 * that we are not currently inside a table.
 */
cvox.NavigationManager.prototype.goToRowLastCell = function() {
  return this.updateSel(this.navShifter_.goToRowLastCell(this.curSel_));
};


/**
 * Traverses to the first cell of the current column of the current table.
 * @return {boolean} Whether or not the traversal was successful. False implies
 * that we are not currently inside a table.
 */
cvox.NavigationManager.prototype.goToColFirstCell = function() {
  return this.updateSel(this.navShifter_.goToColFirstCell(this.curSel_));
};


/**
 * Traverses to the last cell of the current column of the current table.
 * @return {boolean} Whether or not the traversal was successful. False implies
 * that we are not currently inside a table.
 */
cvox.NavigationManager.prototype.goToColLastCell = function() {
  return this.updateSel(this.navShifter_.goToColLastCell(this.curSel_));
};


/**
 * Delegates to NavigationShifter.
 * @return {boolean} Whether or not the command was successful. False implies
 * either we were already on the last row or not in table.
 */
cvox.NavigationManager.prototype.nextRow = function() {
  if (!this.updateSel(this.navShifter_.nextRow(this.curSel_))) {
    // This causes navigation to bump at the end of tables.
    if (this.bumpedEdge_) {
      return false;
    }
    this.bumpedEdge_ = true;
  } else {
    this.bumpedEdge_ = false;
  }
  return true;
};


/**
 * Delegates to NavigationShifter.
 * @return {boolean} Whether or not the command was successful. False implies
 * either we were already on the last col or not in table.
 */
cvox.NavigationManager.prototype.nextCol = function() {
  this.updateSel(this.navShifter_.nextCol(this.curSel_));
  this.bumpedEdge_ = false;
};


/**
 * Returns the text content of the row header(s) of the current cell.
 * @return {!string} The text content of the header(s) of the current cell
 */
cvox.NavigationManager.prototype.getHeaderText = function() {
  return this.navShifter_.getHeaderText(this.curSel_);
};


/**
 * Returns the current row index.
 * @return {Array.<cvox.NavDescription>} The description of our location in
 * a table, or null if not in a table.
 */
cvox.NavigationManager.prototype.getLocationDescription = function() {
  return this.navShifter_.getLocationDescription(this.curSel_);
};


/**
 * Delegates to NavigationShifter.
 */
cvox.NavigationManager.prototype.makeMoreGranular = function() {
  this.navShifter_.makeMoreGranular();
  this.sync();
};


/**
 * Delegates to NavigationShifter.
 */
cvox.NavigationManager.prototype.makeLessGranular = function() {
  this.navShifter_.makeLessGranular();
  this.sync();
};


/**
 * Delegates to NavigationShifter. Behavior is not defined if granularity
 * was not previously gotten from a call to getGranularity();
 * @param {number} granularity The desired granularity.
 */
cvox.NavigationManager.prototype.setGranularity = function(granularity) {
  this.navShifter_.setGranularity(granularity);
};

/**
 * Delegates to NavigationShifter.
 * @return {number} The current granularity.
 */
cvox.NavigationManager.prototype.getGranularity = function() {
  return this.navShifter_.getGranularity();
};


/**
 * Delegates to NavigationShifter.
 */
cvox.NavigationManager.prototype.ensureSubnavigating = function() {
  if (!this.navShifter_.isSubnavigating()) {
    this.navShifter_.ensureSubnavigating();
    this.sync();
  }
};


/**
 * Stops subnavigating, specifying that we should navigate at a less granular
 * level than the current navigation strategy.
 */
cvox.NavigationManager.prototype.ensureNotSubnavigating = function() {
  if (this.navShifter_.isSubnavigating()) {
    this.navShifter_.ensureNotSubnavigating();
    this.sync();
  }
};


/**
 * Delegates to NavigationShifter.
 * @return {boolean} true if in table mode.
 */
cvox.NavigationManager.prototype.isTableMode = function() {
  return this.navShifter_.isTableMode();
};


/**
 * Delegates to NavigationSpeaker.
 * @param {Array.<cvox.NavDescription>} descriptionArray The array of
 *     NavDescriptions to speak.
 * @param {number} initialQueueMode The initial queue mode.
 * @param {Function} completionFunction Function to call when finished speaking.
 *
 */
cvox.NavigationManager.prototype.speakDescriptionArray = function(
    descriptionArray, initialQueueMode, completionFunction) {
  this.navSpeaker_.speakDescriptionArray(
      descriptionArray, initialQueueMode, completionFunction);
};


// TODO(stoarca): The stuff below belongs in its own layer.
/**
 * Moves forward. Stops any subnavigation.
 * @param {boolean=} opt_ignoreIframes Ignore iframes when navigating. Defaults
 * to not ignore iframes.
 * @return {boolean} False if end of document reached.
 */
cvox.NavigationManager.prototype.navigate = function(opt_ignoreIframes) {
  if (!this.resolve()) {
    return false;
  }
  this.ensureNotSubnavigating();
  return this.next_(!opt_ignoreIframes);
};


/**
 * Moves forward after switching to a lower granularity until the next
 * call to navigate().
 */
cvox.NavigationManager.prototype.subnavigate = function() {
  if (!this.resolve()) {
    return;
  }
  this.ensureSubnavigating();
  this.next_(true);
};


/**
 * Moves forward. Starts reading the page from that node.
 * Uses QUEUE_MODE_FLUSH to flush any previous speech.
 * @return {boolean} False if not "reading from here". True otherwise.
 */
cvox.NavigationManager.prototype.skip = function() {
  if (!this.keepReading_) {
    return false;
  }
  if (cvox.ChromeVox.host.hasTtsCallback() && this.next_(true)) {
    this.skipped_ = true;
    this.setReversed(false);
    this.startCallbackReading_(cvox.AbstractTts.QUEUE_MODE_FLUSH);
  }
  return true;
};


/**
 * Starts reading the page from the current selection.
 * @param {number} queueMode Either flush or queue.
 */
cvox.NavigationManager.prototype.startReading = function(queueMode) {
  this.keepReading_ = true;
  if (cvox.ChromeVox.host.hasTtsCallback()) {
    this.startCallbackReading_(queueMode);
  } else {
    this.startNonCallbackReading_(queueMode);
  }
};


/**
 * Starts reading the page from the current selection if there are callbacks.
 * @param {number} queueMode Either flush or queue.
 */
cvox.NavigationManager.prototype.startCallbackReading_ =
    cvox.ChromeVoxEventSuspender.withSuspendedEvents(function(queueMode) {
  this.setFocus();
  this.updateIndicator();

  var desc = this.getDescription();
  this.speakDescriptionArray(desc, queueMode, goog.bind(function() {
    if (this.next_(false)) {
      this.startCallbackReading_(cvox.AbstractTts.QUEUE_MODE_QUEUE);
    }
  }, this));
});


/**
 * Starts reading the page from the current selection if there are no callbacks.
 * With this method, we poll the keepReading_ var and stop when it is false.
 * @param {number} queueMode Either flush or queue.
 */
cvox.NavigationManager.prototype.startNonCallbackReading_ =
    cvox.ChromeVoxEventSuspender.withSuspendedEvents(function(queueMode) {
  if (!this.keepReading_) {
    return;
  }

  if (!cvox.ChromeVox.tts.isSpeaking()) {
    this.setFocus();
    this.updateIndicator();
    this.speakDescriptionArray(this.getDescription(), queueMode, null);
    if (!this.next_(false)) {
      this.keepReading_ = false;
    }
  }
  window.setTimeout(goog.bind(this.startNonCallbackReading_, this), 1000);
});


/**
 * Returns a complete description of the current position, including
 * the text content and annotations such as "link", "button", etc.
 * Unlike getDescription, this does not shorten the position based on the
 * previous position.
 *
 * @return {Array.<cvox.NavDescription>} The summary of the current position.
 */
cvox.NavigationManager.prototype.getFullDescription = function() {
  if (this.pageSel_) {
    return this.pageSel_.getFullDescription();
  }
  return [cvox.DescriptionUtil.getDescriptionFromAncestors(
      cvox.DomUtil.getAncestors(this.curSel_.start.node),
      true,
      cvox.ChromeVox.verbosity)];
};


/**
 * Sets the browser's focus to the current node.
 */
cvox.NavigationManager.prototype.setFocus = function() {
  // TODO(dtseng): cvox.DomUtil.setFocus() totally destroys DOM ranges that have
  // been set on the page; this requires further investigation, but
  // PageSelection won't work without this.
  if (this.pageSel_) {
    return;
  }
  if (this.isTableMode()) {
    // If there is a control element inside a cell, we want to give focus to
    // it so that it can be activated without getting out of table mode.
    cvox.Focuser.setFocus(this.curSel_.start.node, true);
  } else {
    cvox.Focuser.setFocus(this.curSel_.start.node);
  }
};


/**
 * Returns the node of the directed start of the selection.
 * @return {Node} The current node.
 */
cvox.NavigationManager.prototype.getCurrentNode = function() {
  return this.curSel_.absStart().node;
};


/**
 * Listen to messages from other frames and respond to messages that
 * tell our frame to take focus and preseve the navigation granularity
 * from the other frame.
 * @private
 */
cvox.NavigationManager.prototype.addInterframeListener_ = function() {
  /**
   * @type {!cvox.NavigationManager}
   */
  var self = this;

  cvox.Interframe.addListener(function(message) {
    if (message['command'] != 'enterIframe' &&
        message['command'] != 'exitIframe') {
      return;
    }

    window.focus();

    cvox.ChromeVox.serializer.readFrom(message);

    if (message['command'] == 'exitIframe') {
      var id = message['sourceId'];
      var iframeElement = self.iframeIdMap[id];
      if (iframeElement) {
        var reversed = self.isReversed();
        self.updateSel(cvox.CursorSelection.fromNode(iframeElement));
        self.curSel_.setReversed(reversed);
      }
      self.sync();
      self.navigate();
    } else {
      self.syncToPageBeginning();

      // if we have an empty body, then immediately exit the iframe
      if (!cvox.DomUtil.hasContent(document.body)) {
        self.tryIframe_(null);
        return;
      }
    }

    // Now speak what ended up being selected.
    // TODO(deboer): Some of this could be moved to readFrom
    self.setFocus();
    self.updateIndicator();
    self.speakDescriptionArray(
        self.getDescription(),
        cvox.AbstractTts.QUEUE_MODE_FLUSH,
        null);
  });
};


/**
 * Tries to enter a table.
 * @param {{force: (undefined|boolean)}=} kwargs Extra arguments.
 *  force: If true, enters table even if it's a layout table. False by default.
 */
cvox.NavigationManager.prototype.tryEnterTable = function(kwargs) {
  var ret = this.navShifter_.tryEnterTable(this.curSel_, kwargs);
  if (ret) {
    this.curSel_ = ret;
  }
};


/**
 * Exits a table in the direction of sel.
 */
cvox.NavigationManager.prototype.tryExitTable = function() {
  var r = this.isReversed();
  // TODO (deboer): Move this method to cvox.NavigationShifter.
  // TODO (stoarca): I don't think it makes sense that when we switch out of
  // table mode, we jump out of the table. This means that I can't toggle
  // between table mode and not, despite the user command that claims to do
  // so. Keeping it for now to comply with old tests.
  this.navShifter_.ensureNotTableMode();
  this.bumpedEdge_ = false;
  if (this.navShifter_.isInTable(this.curSel_)) {
    var node = cvox.DomUtil.getContainingTable(this.curSel_.start.node);
    if (!node) {
      // we were not in a table.
      return;
    }
    do {
      node = cvox.DomUtil.directedNextLeafNode(node, r);
    } while (node && !cvox.DomUtil.hasContent(node));
    var sel = cvox.CursorSelection.fromNode(node);
    if (sel) {
      sel.setReversed(r);
    }
    this.tryBoundaries_(sel, true);
    this.sync();
  }
};


/**
 * Returns the filteredWalker.
 * @return {!cvox.WalkerDecorator} The filteredWalker.
 */
cvox.NavigationManager.prototype.getFilteredWalker = function() {
  // TODO (stoarca): Should not be exposed. Delegate instead.
  return this.navShifter_.filteredWalker;
};


/**
 * Update the active indicator to reflect the current node or selection.
 */
cvox.NavigationManager.prototype.updateIndicator = function() {
  this.activeIndicator.syncToCursorSelection(this.curSel_);
};


/**
 * Show or hide the active indicator based on whether ChromeVox is
 * active or not.
 *
 * If 'active' is true, cvox.NavigationManager does not do anything.
 * However, callers to showOrHideIndicator also need to call updateIndicator
 * to update the indicator -- which also does the work to show the
 * indicator.
 *
 * @param {boolean} active True if we should show the indicator, false
 *     if we should hide the indicator.
 */
cvox.NavigationManager.prototype.showOrHideIndicator = function(active) {
  if (!active) {
    this.activeIndicator.removeFromDom();
  }
};


/**
 * This is used to update the selection to arbitrary nodes because there are
 * some callers who have the expectation that this works. The caller should
 * expect the CursorSelection to sync to a node that we can describe. This may
 * not be the same node given.
 * @param {Node} node The node to update to.
 */
cvox.NavigationManager.prototype.updateSelToArbitraryNode = function(node) {
  // We assume ObjectWalker is magical and does what we want (and is the
  // only one with such properties). This assumption is wrong, but we'll
  // have to make it until we have a better way to do this.
  this.setGranularity(cvox.NavigationShifter.GRANULARITIES.OBJECT);
  if (node) {
    this.updateSel(cvox.CursorSelection.fromNode(node));
    this.sync();
  } else {
    this.syncToPageBeginning();
  }
};


/**
 * Updates curSel_ to the new selection and sets prevSel_ to the old curSel_.
 * This should be called exactly when something user-perceivable happens.
 * @param {cvox.CursorSelection} sel The selection to update to.
 * @param {cvox.CursorSelection} opt_context An optional override for prevSel_.
 * Used to override both curSel_ and prevSel_ when jumping back in nav history.
 * @return {boolean} False if sel is null. True otherwise.
 */
cvox.NavigationManager.prototype.updateSel = function(sel, opt_context) {
  if (sel) {
    this.prevSel_ = opt_context || this.curSel_;
    this.curSel_ = sel;
  }
  // Always update the navigation history.
  var currentNode = this.getCurrentNode();
  this.navigationHistory_.update(currentNode);

  return !!sel;
};


/**
 * Sets the direction.
 * @param {!boolean} r True to reverse.
 */
cvox.NavigationManager.prototype.setReversed = function(r) {
  this.curSel_.setReversed(r);
};


/**
 * Returns true if currently reversed.
 * @return {boolean} True if reversed.
 */
cvox.NavigationManager.prototype.isReversed = function() {
  return this.curSel_.isReversed();
};


/**
 * Checks if boundary conditions are met and updates the selection.
 * @param {cvox.CursorSelection} sel The selection.
 * @param {boolean=} iframes If true, tries to enter iframes. Default false.
 * @return {boolean} False if end of page is reached.
 * @private
 */
cvox.NavigationManager.prototype.tryBoundaries_ = function(sel, iframes) {
  this.pageEnd_ = false;
  iframes = (!!iframes && !this.ignoreIframesNoMatterWhat_) || false;
  if (iframes && this.tryIframe_(sel && sel.start.node)) {
    return true;
  }
  if (this.tryTable_(sel)) {
    return true;
  }
  this.syncToPageBeginning();
  this.pageEnd_ = true;
  return false;
};


/**
 * Given a node that we just navigated to, try to jump in and out of iframes
 * as needed. If the node is an iframe, jump into it. If the node is null,
 * assume we reached the end of an iframe and try to jump out of it.
 * @param {Node} node The node to try to jump into.
 * @return {boolean} True if we jumped into an iframe.
 * @private
 */
cvox.NavigationManager.prototype.tryIframe_ = function(node) {
  if (node == null && cvox.Interframe.isIframe()) {
    var message = {
      'command': 'exitIframe'
    };
    cvox.ChromeVox.serializer.storeOn(message);
    cvox.Interframe.sendMessageToParentWindow(message);
    return true;
  }

  if (node == null || node.tagName != 'IFRAME' || !node.src) {
    return false;
  }

  var iframeElement = /** @type {HTMLIFrameElement} */(node);

  var iframeId = undefined;
  for (var id in this.iframeIdMap) {
    if (this.iframeIdMap[id] == iframeElement) {
      iframeId = id;
      break;
    }
  }
  if (iframeId == undefined) {
    iframeId = this.nextIframeId;
    this.nextIframeId++;
    this.iframeIdMap[iframeId] = iframeElement;
    cvox.Interframe.sendIdToIFrame(iframeId, iframeElement);
  }

  var message = {
    'command': 'enterIframe',
    'id': iframeId
  };
  cvox.ChromeVox.serializer.storeOn(message);
  cvox.Interframe.sendMessageToIFrame(message, iframeElement);

  return true;
};


/**
 * Enters or exits a table (updates the selection) if sel is significant.
 * @param {cvox.CursorSelection} sel The selection (possibly null).
 * @return {boolean} False means the end of the page was reached.
 * @private
 */
cvox.NavigationManager.prototype.tryTable_ = function(sel) {
  if (this.isTableMode()) {
    if (sel) {
      this.updateSel(sel);
      this.bumpedEdge_ = false;
      return true;
    }
    this.tryExitTable();
    return true;
  } else {
    if (!sel) {
      return false;
    }
    this.updateSel(sel);
    this.tryEnterTable();
    return true;
  }
};


/**
 * Delegates to NavigationShifter. Tries to enter any iframes or tables.
 */
cvox.NavigationManager.prototype.syncToPageBeginning = function() {
  var ret = this.navShifter_.syncToPageBeginning({
      reversed: this.curSel_.isReversed()
  });
  if (this.tryIframe_(ret && ret.start.node)) {
    return;
  }
  this.tryTable_(ret);
};


/**
 * Used during testing since there are iframes and we don't always want to
 * interact with them so that we can test certain features.
 */
cvox.NavigationManager.prototype.ignoreIframesNoMatterWhat = function() {
  this.ignoreIframesNoMatterWhat_ = true;
};
