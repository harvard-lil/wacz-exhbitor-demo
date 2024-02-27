/**
 * `<warc-embed-timeline>`: Prototype for an HTML custom element interacting with a `warc-embed` `<iframe>` to help build interactive timelines using web archives.
 */
class WarcEmbedTimeline extends HTMLElement {

  /** 
   * @type {?HTMLIFrameElement} 
   * Reference to the warc-embed `<iframe>` this component interacts with. 
   */
  iframe = null;

  /** 
   * @type {?String} 
   * Origin of the warc-embed `<iframe>` this component interacts with.
   */
  get iframeOrigin() {
    return this.iframe ? new URL(this.iframe.src).origin : null;
  }

  /**
   * @type {?Number}
   * Reference to the interval used to pull `collInfo` from the warc-embed `<iframe>`.
   */
  #requestCollInfoInterval = null;

  /**
   * @type {?Object}
   * Copy of `<replay-web-page>`'s `collInfo` object transmitted by warc-embed, containing meta information about the web archive.
   * Used mainly to build `this.timeline`, containing all the available timestamps for the current url.
   */
  collInfo = null;

  /**
   * @type {?String}
   * `url` value as returned by `<replay-web-page>` during the last navigation event.
   */
  url = null;

  /**
   * @type {?String}
   * `ts` value as returned by `<replay-web-page>` during the last navigation event.
   */
  ts = null;

  /**
   * @type {Number[]} 
   * List of available timestamps (ts) in the web archive for the currently displayed url.
   */
  timeline = [];

  /**
   * @type {?Number}
   * Indicates the position of the currently displayed page in `this.timeline`.
   */
  timelineIndex = null;

  /**
   * Upon injection into the dom:
   * - Try to find warc-embed `<iframe>` this element is meant to interact with.
   * - Start listening for postMessages coming from said `<iframe>`.
   * - Start requesting `collInfo` every 250ms until it's available and processed.
   * 
   * @returns {null}
   */
  connectedCallback() {
    // Was `iframe-id` provided?
    const iframeId = this.getAttribute("iframe-id");
    
    if (!iframeId) {
      throw new Error(`"iframe-id" must be provided and be the id of a warc-embed "<iframe>".`); 
    }

    // Pull reference to warc-embed `<iframe>` 
    try {
      this.iframe = document.querySelector(`iframe#${iframeId}`);
    }
    catch(err) {
      this.iframe = null;
      throw new Error(`"iframe-id" must be the id of a warc-embed "<iframe>".`);
    }

    // Intercept messages coming from the warc-embed `<iframe>`
    window.addEventListener("message", this.handleMessagesFromIframe);

    // Ask for `collInfo` until it's available
    this.#requestCollInfoInterval = setInterval(this.requestCollInfo, 250);
  }

  /**
   * Upon ejection from DOM:
   * - Remove event listeners added to nodes outside of this component
   * - Clear intervals
   */
  disconnectedCallback() {
    window.removeEventListener(this.handleMessagesFromIframe);
    this.#requestCollInfoInterval ? clearInterval(this.#requestCollInfoInterval) : null;
  }

  /**
   * Observed attributes:
   * - `show-range-input`
   * - `show-select`
   * 
   * @returns {Array}
   */
  static get observedAttributes() {
    return ["show-range-input", "show-select"];
  }

  /**
   * On observed attribute change: re-render.
   * @param {String} name 
   * @param {?String} oldValue 
   * @param {?String} newValue 
   * 
   * @returns {null}
   */
  attributeChangedCallback(name, oldValue, newValue) {
    this.render();
  }

  /**
   * Clears `this.innerHTML` and renders HTML for selected controls.
   * @returns {null}
   */
  render() {
    this.innerHTML = /*html*/``;

    if (this.getAttribute("show-range-input") !== null) {
      this.renderRangeInput();
    }

    if (this.getAttribute("show-select") !== null) {
      this.renderSelect();
    }
  }

  /**
   * Builds and appends to `this.innerHTML` a `<input type="range">` timeline control based on `this.timeline` and `this.timelineIndex`.
   * Binds `change` event to `this.handleInputRangeChange`.
   * @returns {null}
   */
  renderRangeInput = () => {
    this.innerHTML += /*html*/`
      <input 
        id="${this.getAttribute("iframe-id")}-input-range"
        type="range" 
        min="0" 
        max="${this.timeline.length - 1}" 
        value="${this.timelineIndex}"
        list="${this.getAttribute("iframe-id")}-input-range-datalist"
      />
    `;

    let datalistHTML = /*html*/`<datalist id="${this.getAttribute("iframe-id")}-input-range-datalist">`;
    this.timeline.forEach((ts, i) => {
      datalistHTML += /*html*/`<option value="${i}"></option>`;
    });
    datalistHTML += /*html*/`</datalist>`;

    this.innerHTML += datalistHTML;

    requestAnimationFrame(() => {
      this.querySelector("input[type='range']")?.addEventListener(
        "change",
        this.handleInputRangeChange
      );
    });
  }

  /**
   * Builds and appends to `this.innerHTML` a `<select>` timeline control based on `this.timeline` and `this.timelineIndex`.
   * Binds `change` event to `this.handleSelectChange`.
   * @returns {null}
   */
  renderSelect = () => {
    let selectHTML = /*html*/`
      <select 
        id="${this.getAttribute("iframe-id")}-select"
        name="${this.getAttribute("iframe-id")}-select">
    `;
      
    this.timeline.forEach((ts, i) => {
      selectHTML += /*html*/`<option value="${i}" ${i === this.timelineIndex ? "selected" : ""}>`;
      selectHTML += new Intl.DateTimeFormat().format(new Date(ts));
      selectHTML += /*html*/`</option>`;
    });

    selectHTML += /*html*/`</select>`;

    this.innerHTML += selectHTML;

    requestAnimationFrame(() => {
      this.querySelector("select")?.addEventListener(
        "change",
        this.handleSelectChange
      );
    });
  }

  /**
   * Catches and processes postMessages coming from the warc-embed `<iframe>`.
   * - Ignores messages that do not bear data or come from other sources.
   * - Uses navigation messages to updates `this.url` and `this.ts`.
   * - Uses archive info messages to grab and process `collInfo`.
   * 
   * Will rebuild `this.timeline` and re-render as needed (url changed, `collInfo` received ...).
   * 
   * @param {Event} event 
   * @returns {null}
   */
  handleMessagesFromIframe = (event) => {
    // Ignore messages if empty or not from our target `<iframe>`
    if (!event?.data || event.source !== this.iframe.contentWindow) {
      return;
    }

    let needsReRender = false;

    // Navigation message: grab `url` and `ts`
    if (event.data?.view && event.data.view === "pages") {
      const currentUrl = this.removeHashFromUrl(this.url);
      const newUrl = this.removeHashFromUrl(event.data.url);

      if (newUrl != currentUrl) { // Only force a re-render if we changed page
        needsReRender = true;
      }

      this.url = newUrl;
      this.ts = event.data.ts
    }

    // Archive info message: Grab `collInfo`
    if (event.data?.collInfo && event.data.collInfo?.pages) {
      this.collInfo = event.data.collInfo;
      needsReRender = true;
    }

    // If needed: (re)process timeline data from `collInfo`, re-render.
    if (needsReRender) {
      this.buildTimelineForCurrentUrl();
      this.render();
    }
  }

  /**
   * Tries to navigate to the next available `ts` in `this.timeline`.
   * Calls `this.updateTimelineIndex`.
   * @returns {null}
   */
  navigateNextTs = () => {
    let nextIndex = this.timelineIndex + 1;

    if (nextIndex >= this.timeline.length) {
      return;
    }

    this.updateTimelineIndex(nextIndex);
  }

  /**
   * Tries to navigate to the previous `ts` in `this.timeline`.
   * Calls `this.updateTimelineIndex`.
   * @returns {null}
   */
  navigatePreviousTs = () => {
    let previousIndex = this.timelineIndex - 1;

    if (previousIndex < 0) {
      return;
    }

    this.updateTimelineIndex(previousIndex);
  }

  /**
   * Calls `this.updateTimelineIndex` when `<select>` value changes.
   * @param {Event} event 
   * @returns {null}
   */
  handleInputRangeChange = (event) => {
    if (!event.target?.value) {
      return;
    }

    this.updateTimelineIndex(event.target.value);

    // Compensate for annoying forced-focus on `<replay-web-page>`
    setTimeout(() => this.querySelector("input[type='range']").focus(), 250);
  }

  /**
   * Calls `this.updateTimelineIndex` when `<select>` value changes.
   * @param {Event} event 
   * @returns {null}
   */
  handleSelectChange = (event) => {
    if (!event.target?.value) {
      return;
    }

    this.updateTimelineIndex(event.target.value);

    // Compensate for annoying forced-focus on `<replay-web-page>`
    setTimeout(() => this.querySelector("select").focus(), 250);
  }

  /**
   * Updates `this.timelineIndex`, pulls the associated timestamp from `this.timeline`, and sends it via postMessage to warc-embed.
   * This operation should result in `<replay-web-page>` rendering a different version of the currently displayed url.
   * @param {*} newIndex 
   * @returns {null}
   */
  updateTimelineIndex = (newIndex) => {
    const index = parseInt(newIndex);

    if (index < 0 || index >= this.timeline.length) {
      return;
    }

    this.timelineIndex = index;

    this.iframe.contentWindow.postMessage(
      { updateTs: this.timeline[index] },
      this.iframeOrigin
    );

    this.render();
  }

  /**
   * Sends a postMessage to warc-embed to retrieve `<replay-web-page>`'s `collInfo` object.
   * Message will not be sent if `this.collInfo` already exists. 
   * @returns {null}
   */
  requestCollInfo = () => {
    if (this.collInfo && this.collInfo?.pages) {
      clearInterval(this.#requestCollInfoInterval);
      return;
    }

    this.iframe.contentWindow.postMessage({ getCollInfo: true }, this.iframeOrigin);
  }

  /**
   * Iterates over `this.collInfo` to build `this.timeline`, a sorted collection of timestamps representing all the available entries in the archive for the current url.
   * Will set `this.timelineIndex` to `0` if not set.
   * @returns {null}
   */
  buildTimelineForCurrentUrl = () => {
    if (!this.collInfo || !this.collInfo?.pages) {
      return;
    }

    for (let page of this.collInfo.pages) {
      const pageUrl = this.removeHashFromUrl(page.url);
      const currentUrl = this.removeHashFromUrl(this.url);

      if (pageUrl === currentUrl) {
        this.timeline.push(page.ts);
      }
    }

    this.timeline.sort();

    // Set `timelineIndex` to beginning of timeline if not set.
    if (this.timelineIndex === null && this.timeline) {
      this.timelineIndex = 0;
    }
  }

  /**
   * Utility function to remove the #hash portion of a url.
   * @param {String} url 
   * @returns {String}
   */
  removeHashFromUrl(url) {
    if (!url) {
      return "";
    }

    return String(url).replace(/\#[a-zA-Z0-9\_\-\+\=\%]+/, "");
  }

}
customElements.define("warc-embed-timeline", WarcEmbedTimeline);

