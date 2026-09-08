
      (() => {
        const MAX_DAMAGE = 100000;
        // 비공부 데미지 속도는 고정. 목표 순공시간에 따라 공부 중 회복 속도를 자동 계산한다.
        // 균형 조건: IDLE_RATE × (24-goal) + STUDY_RATE × goal = 0
        const IDLE_RATE = 0.289; // damage / sec
        const DEFAULT_GOAL_HOURS = 4;

        const TAB_LOCK_KEY = "mentalStudyActiveTabV1";
        const TAB_ID_KEY = "mentalStudyTabIdV1";
        const TAB_LOCK_TTL = 8000;
        const TAB_LOCK_HEARTBEAT = 2000;

        // sessionStorage는 같은 탭의 새로고침에서는 유지되고,
        // 새 탭/새 창에서는 별도의 값을 가진다.
        // 따라서 실행권을 획득한 뒤 location.reload()되어도 같은 tabId를 유지해야 한다.
        let tabId = sessionStorage.getItem(TAB_ID_KEY);
        if (!tabId) {
          tabId =
            globalThis.crypto && crypto.randomUUID
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          sessionStorage.setItem(TAB_ID_KEY, tabId);
        }

        function readTabLock() {
          try {
            return JSON.parse(localStorage.getItem(TAB_LOCK_KEY) || "null");
          } catch {
            return null;
          }
        }
        function lockIsFresh(lock, now = Date.now()) {
          return !!(
            lock &&
            lock.id &&
            Number.isFinite(Number(lock.ts)) &&
            now - Number(lock.ts) < TAB_LOCK_TTL
          );
        }
        function tryAcquireTabLock() {
          const now = Date.now();
          const current = readTabLock();
          if (lockIsFresh(current, now) && current.id !== tabId) return false;
          localStorage.setItem(
            TAB_LOCK_KEY,
            JSON.stringify({ id: tabId, ts: now }),
          );
          const verified = readTabLock();
          return !!(verified && verified.id === tabId);
        }
        function showSecondaryTabOverlay() {
          const overlay = document.getElementById("singleTabOverlay");
          if (overlay) overlay.classList.add("show");
        }
        function waitForPrimaryTabToClose() {
          showSecondaryTabOverlay();
          const recheck = () => {
            if (tryAcquireTabLock()) {
              location.reload();
            }
          };
          const button = document.getElementById("singleTabCheckBtn");
          if (button) button.addEventListener("click", recheck);
          window.addEventListener("storage", (event) => {
            if (event.key === TAB_LOCK_KEY) recheck();
          });
          setInterval(recheck, 2500);
        }
        if (!tryAcquireTabLock()) {
          waitForPrimaryTabToClose();
          return;
        }

        const state = JSON.parse(
          localStorage.getItem("mentalStudyStateV1") || "{}",
        );
        let damage = typeof state.damage === "number" ? state.damage : 0;
        let studying = !!state.studying;
        let dayKey = state.dayKey || todayKey();
        let todaySeconds = Number(state.todaySeconds || 0);
        let records =
          state.records && typeof state.records === "object"
            ? state.records
            : {};
        let dailyDamageChanges =
          state.dailyDamageChanges &&
          typeof state.dailyDamageChanges === "object" &&
          !Array.isArray(state.dailyDamageChanges)
            ? state.dailyDamageChanges
            : {};
        let lastTs = Number(state.lastTs || Date.now());
        let goalHours = Math.max(
          1,
          Math.min(24, Number(state.goalHours || DEFAULT_GOAL_HOURS)),
        );
        let gold = Math.max(0, Number(state.gold || 0));
        let recoveryBoostUntil = Math.max(
          0,
          Number(state.recoveryBoostUntil || 0),
        );

        // v1.1+ 일별 멘탈 데미지 변화량.
        // 구버전 데이터에는 이 필드가 없으므로 과거 날짜는 "기록 없음"으로 취급한다.
        if (!Object.prototype.hasOwnProperty.call(dailyDamageChanges, dayKey)) {
          dailyDamageChanges[dayKey] = 0;
        }

        function hasDamageChangeRecord(key) {
          return Object.prototype.hasOwnProperty.call(dailyDamageChanges, key);
        }

        function recordDamageDelta(delta, key = dayKey) {
          delta = Number(delta);
          if (!Number.isFinite(delta) || Math.abs(delta) < 1e-9) return;
          const current = Number(dailyDamageChanges[key]);
          dailyDamageChanges[key] =
            (Number.isFinite(current) ? current : 0) + delta;
        }

        function setDamageTracked(nextDamage, key = dayKey) {
          const before = damage;
          damage = Math.max(0, Math.min(MAX_DAMAGE, Number(nextDamage) || 0));
          recordDamageDelta(damage - before, key);
          return damage;
        }

        function signedDamageText(value) {
          if (
            value === null ||
            value === undefined ||
            !Number.isFinite(Number(value))
          ) {
            return "—";
          }
          const rounded = Math.round(Number(value));
          if (rounded > 0) return "+" + rounded.toLocaleString("ko-KR");
          if (rounded < 0) return rounded.toLocaleString("ko-KR");
          return "0";
        }

        function localDateKey(date) {
          return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        }

        function dateKeyDaysAgo(daysAgo) {
          const d = new Date();
          d.setHours(12, 0, 0, 0);
          d.setDate(d.getDate() - Math.max(0, Number(daysAgo) || 0));
          return localDateKey(d);
        }

        function damageTrendData(days) {
          const count = Math.max(
            2,
            Math.min(90, Math.floor(Number(days) || 7)),
          );
          const result = [];
          for (let i = count - 1; i >= 0; i--) {
            const key = dateKeyDaysAgo(i);
            result.push({
              key,
              label: key.slice(5).replace("-", "/"),
              value: hasDamageChangeRecord(key)
                ? Number(dailyDamageChanges[key]) || 0
                : null,
            });
          }
          return result;
        }

        function studyRate() {
          return goalHours >= 24
            ? 0
            : (-IDLE_RATE * (24 - goalHours)) / goalHours;
        }

        function isRecoveryBoostActive(at = Date.now()) {
          return recoveryBoostUntil > at;
        }
        function boostedStudyRate(at = Date.now()) {
          return studyRate() * (isRecoveryBoostActive(at) ? 2 : 1);
        }
        function boosterRemainingMs(at = Date.now()) {
          return Math.max(0, recoveryBoostUntil - at);
        }
        function fmtCountdown(ms) {
          const total = Math.max(0, Math.ceil(ms / 1000));
          const h = Math.floor(total / 3600);
          const m = Math.floor((total % 3600) / 60);
          const s = total % 60;
          return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        }

        const $ = (id) => document.getElementById(id);

        // 우측 상단 유틸리티 메뉴 / 도움말
        const utilityMenuToggle = $("utilityMenuToggle");
        const utilityMenuPanel = $("utilityMenuPanel");

        function setUtilityMenu(open) {
          utilityMenuPanel.classList.toggle("open", open);
          utilityMenuToggle.setAttribute("aria-expanded", String(open));
        }

        utilityMenuToggle.addEventListener("click", (e) => {
          e.stopPropagation();
          setUtilityMenu(!utilityMenuPanel.classList.contains("open"));
        });

        utilityMenuPanel.addEventListener("click", (e) => e.stopPropagation());
        document.addEventListener("click", () => setUtilityMenu(false));

        $("patchOpen").addEventListener("click", () => {
          setUtilityMenu(false);
          $("patchModal").showModal();
        });

        $("closePatch").addEventListener("click", () =>
          $("patchModal").close(),
        );
        $("patchModal").addEventListener("click", (e) => {
          if (e.target === $("patchModal")) $("patchModal").close();
        });

        $("helpOpen").addEventListener("click", () => {
          setUtilityMenu(false);
          $("helpModal").showModal();
        });

        $("closeHelp").addEventListener("click", () => $("helpModal").close());
        $("helpModal").addEventListener("click", (e) => {
          if (e.target === $("helpModal")) $("helpModal").close();
        });

        // 현재 상태 공유 카드
        const SHARE_SITE_URL = "https://mental.study-log.kro.kr";

        function shareStatusLine(grade) {
          const lines = {
            대현자: "오늘은 내가 신이다.",
            평온: "아직은 멀쩡하다.",
            동요: "슬슬 공부가 신경 쓰이기 시작했다.",
            균열: "멘탈에 금이 가는 중.",
            붕괴: "인간성이 무너지는 중.",
            멘헤라: "돌아갈 수 있을까.",
            정신분열: "멘탈 게이지가 끝까지 와버렸다.",
          };
          return lines[grade.name] || "오늘의 멘탈을 기록하는 중.";
        }

        function shareCanvasDataUrl() {
          const canvas = $("shareCanvas");
          return canvas.toDataURL("image/png");
        }

        async function shareCanvasBlob() {
          const dataUrl = shareCanvasDataUrl();
          const response = await fetch(dataUrl);
          return await response.blob();
        }

        function roundedRect(ctx, x, y, w, h, r) {
          const radius = Math.min(r, w / 2, h / 2);
          ctx.beginPath();
          ctx.moveTo(x + radius, y);
          ctx.arcTo(x + w, y, x + w, y + h, radius);
          ctx.arcTo(x + w, y + h, x, y + h, radius);
          ctx.arcTo(x, y + h, x, y, radius);
          ctx.arcTo(x, y, x + w, y, radius);
          ctx.closePath();
        }

        async function drawShareCard() {
          const canvas = $("shareCanvas");
          const ctx = canvas.getContext("2d");
          const g = currentGrade();
          const W = canvas.width;
          const H = canvas.height;
          const dmg = Math.max(0, Math.min(MAX_DAMAGE, damage));
          const pct = dmg / MAX_DAMAGE;
          const pad = 72;

          // Paper background
          ctx.clearRect(0, 0, W, H);
          ctx.fillStyle = "#f7f5ef";
          ctx.fillRect(0, 0, W, H);

          ctx.strokeStyle = "rgba(80, 120, 180, 0.075)";
          ctx.lineWidth = 1;
          for (let p = 28; p < W; p += 28) {
            ctx.beginPath();
            ctx.moveTo(p, 0);
            ctx.lineTo(p, H);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, p);
            ctx.lineTo(W, p);
            ctx.stroke();
          }

          // Outer card
          ctx.fillStyle = "rgba(255,253,248,0.97)";
          ctx.strokeStyle = "#9c978d";
          ctx.lineWidth = 3;
          roundedRect(ctx, 38, 38, W - 76, H - 76, 26);
          ctx.fill();
          ctx.stroke();

          ctx.save();
          ctx.setLineDash([9, 9]);
          ctx.strokeStyle = "rgba(95,88,74,0.28)";
          ctx.lineWidth = 2;
          roundedRect(ctx, 52, 52, W - 104, H - 104, 20);
          ctx.stroke();
          ctx.restore();

          // Header
          ctx.fillStyle = "#716c64";
          ctx.font = '900 28px "Noto Sans KR", Arial, sans-serif';
          ctx.fillText("MENHERA'S STUDYLOG · MENTAL STATUS", pad, 118);

          // Mental badge
          ctx.fillStyle = g.color + "22";
          ctx.strokeStyle = g.color;
          ctx.lineWidth = 3;
          roundedRect(ctx, pad, 154, W - pad * 2, 158, 26);
          ctx.fill();
          ctx.stroke();
          const shareIcon = await loadGradeImage(g);
          ctx.drawImage(shareIcon, pad + 18, 164, 100, 100);

          ctx.fillStyle = g.color;
          ctx.font = '900 61px "Noto Sans KR", Arial, sans-serif';
          ctx.fillText(g.name, pad + 142, 222);

          ctx.fillStyle = "#615b53";
          ctx.font = '700 29px "Noto Sans KR", Arial, sans-serif';
          ctx.fillText(shareStatusLine(g), pad + 142, 268);

          // Damage
          ctx.fillStyle = "#777168";
          ctx.font = '900 25px "Noto Sans KR", Arial, sans-serif';
          ctx.fillText("MENTAL DAMAGE", pad, 360);

          ctx.fillStyle = "#242424";
          ctx.font = '900 57px "Courier New", monospace';
          ctx.fillText(
            `${Math.round(dmg).toLocaleString("ko-KR")} / ${MAX_DAMAGE.toLocaleString("ko-KR")}`,
            pad,
            420,
          );

          // Damage bar
          const barX = pad;
          const barY = 452;
          const barW = W - pad * 2;
          const barH = 42;
          ctx.fillStyle = "#eee9df";
          ctx.strokeStyle = "#8d887f";
          ctx.lineWidth = 3;
          roundedRect(ctx, barX, barY, barW, barH, 10);
          ctx.fill();
          ctx.stroke();

          if (pct > 0) {
            ctx.fillStyle = g.color;
            roundedRect(
              ctx,
              barX + 5,
              barY + 5,
              Math.max(8, (barW - 10) * pct),
              barH - 10,
              7,
            );
            ctx.fill();
          }

          ctx.fillStyle = "#504b44";
          ctx.font = '900 24px "Courier New", monospace';
          ctx.textAlign = "right";
          ctx.fillText(`${(pct * 100).toFixed(1)}%`, W - pad, barY + 77);
          ctx.textAlign = "left";

          // Stats cards
          const gap = 22;
          const statW = (barW - gap) / 2;
          const statY = 528;
          const statH = 132;

          const drawStat = (x, label, value, sub) => {
            ctx.fillStyle = "#fffdf8";
            ctx.strokeStyle = "#bdb6aa";
            ctx.lineWidth = 2;
            roundedRect(ctx, x, statY, statW, statH, 20);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = "#7b756d";
            ctx.font = '900 24px "Noto Sans KR", Arial, sans-serif';
            ctx.fillText(label, x + 26, statY + 37);

            ctx.fillStyle = "#242424";
            ctx.font = '900 47px "Courier New", monospace';
            ctx.fillText(value, x + 26, statY + 91);

            if (sub) {
              ctx.fillStyle = "#777168";
              ctx.font = '700 22px "Noto Sans KR", Arial, sans-serif';
              ctx.fillText(sub, x + 26, statY + 145);
            }
          };

          drawStat(pad, "오늘 순공", fmt(todaySeconds), "");
          drawStat(pad + statW + gap, "일일 목표", `${goalHours}시간`, "");

          // Daily mental-damage trend
          const trendDays = Math.max(
            2,
            Math.min(90, Number($("shareTrendDays")?.value || 7)),
          );
          const trend = damageTrendData(trendDays);
          const graphX = pad;
          const graphY = 700;
          const graphW = barW;
          const graphH = 210;

          ctx.fillStyle = "#777168";
          ctx.font = '900 22px "Noto Sans KR", Arial, sans-serif';
          ctx.fillText(
            `멘탈 변화 추이 · 최근 ${trendDays}일`,
            graphX,
            graphY - 12,
          );

          ctx.fillStyle = "#fffdf8";
          ctx.strokeStyle = "#bdb6aa";
          ctx.lineWidth = 2;
          roundedRect(ctx, graphX, graphY, graphW, graphH, 15);
          ctx.fill();
          ctx.stroke();

          const knownValues = trend
            .map((p) => p.value)
            .filter((v) => v !== null && Number.isFinite(v));
          const absMax = Math.max(1, ...knownValues.map((v) => Math.abs(v)));
          const innerLeft = graphX + 22;
          const innerRight = graphX + graphW - 22;
          const innerTop = graphY + 16;
          const innerBottom = graphY + graphH - 25;
          const zeroY = (innerTop + innerBottom) / 2;

          ctx.save();
          ctx.setLineDash([5, 5]);
          ctx.strokeStyle = "#c9c2b7";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(innerLeft, zeroY);
          ctx.lineTo(innerRight, zeroY);
          ctx.stroke();
          ctx.restore();

          const pointX = (i) =>
            trend.length <= 1
              ? innerLeft
              : innerLeft + ((innerRight - innerLeft) * i) / (trend.length - 1);
          const pointY = (value) =>
            zeroY -
            (Number(value) / absMax) * ((innerBottom - innerTop) / 2 - 5);

          let prevKnown = null;
          for (let i = 0; i < trend.length; i++) {
            const p = trend[i];
            if (p.value === null || !Number.isFinite(p.value)) {
              prevKnown = null;
              continue;
            }
            const x = pointX(i);
            const y = pointY(p.value);

            if (prevKnown) {
              ctx.strokeStyle = "#4a4742";
              ctx.lineWidth = 3;
              ctx.beginPath();
              ctx.moveTo(prevKnown.x, prevKnown.y);
              ctx.lineTo(x, y);
              ctx.stroke();
            }

            ctx.fillStyle =
              p.value > 0 ? "#a44e59" : p.value < 0 ? "#4f7562" : "#777168";
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fill();
            prevKnown = { x, y };
          }

          // Keep date labels readable: first/last only.
          ctx.fillStyle = "#817b72";
          ctx.font = '700 16px "Courier New", monospace';
          ctx.textAlign = "left";
          ctx.fillText(trend[0]?.label || "", innerLeft, graphY + graphH - 7);
          ctx.textAlign = "right";
          ctx.fillText(
            trend[trend.length - 1]?.label || "",
            innerRight,
            graphY + graphH - 7,
          );
          ctx.textAlign = "left";

          if (knownValues.length === 0) {
            ctx.fillStyle = "#9a948b";
            ctx.font = '700 18px "Noto Sans KR", Arial, sans-serif';
            ctx.textAlign = "center";
            ctx.fillText(
              "이 기간의 멘탈 변화 기록이 아직 없어",
              graphX + graphW / 2,
              zeroY + 6,
            );
            ctx.textAlign = "left";
          }

          // Footer
          ctx.strokeStyle = "#cbc4b9";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(pad, 928);
          ctx.lineTo(W - pad, 928);
          ctx.stroke();

          ctx.fillStyle = "#4f4a44";
          ctx.font = '900 29px "Noto Sans KR", Arial, sans-serif';
          ctx.fillText("공부 안 하면 멘탈 데미지가 쌓이는 타이머", pad, 966);

          ctx.fillStyle = "#777168";
          ctx.font = '700 24px "Noto Sans KR", Arial, sans-serif';
          ctx.fillText(SHARE_SITE_URL.replace("https://", ""), pad, 1005);

          ctx.textAlign = "right";
          ctx.fillStyle = "#8a857d";
          ctx.font = '700 21px "Noto Sans KR", Arial, sans-serif';
          ctx.fillText(new Date().toLocaleDateString("ko-KR"), W - pad, 1005);
          ctx.textAlign = "left";
        }

        async function openShareModal() {
          setUtilityMenu(false);
          await drawShareCard();
          $("shareNote").textContent = "";
          $("shareModal").showModal();
        }

        $("shareOpen").addEventListener("click", () => {
          openShareModal();
        });

        $("shareTrendDays").addEventListener("change", async () => {
          const input = $("shareTrendDays");
          input.value = String(
            Math.max(2, Math.min(90, Math.floor(Number(input.value) || 7))),
          );
          await drawShareCard();
        });

        $("closeShare").addEventListener("click", () =>
          $("shareModal").close(),
        );
        $("shareModal").addEventListener("click", (e) => {
          if (e.target === $("shareModal")) $("shareModal").close();
        });

        $("shareDownloadBtn").addEventListener("click", async () => {
          try {
            $("shareNote").textContent = "이미지 생성 중...";
            await drawShareCard();

            let dataUrl;
            try {
              dataUrl = shareCanvasDataUrl();
            } catch (err) {
              throw err;
            }

            const a = document.createElement("a");
            a.href = dataUrl;
            a.download = `MenherasStudyLog_${currentGrade().name}_${new Date()
              .toISOString()
              .slice(0, 10)}.png`;
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            a.remove();
            $("shareNote").textContent = "공유 카드 이미지 저장을 요청했어.";
          } catch (err) {
            $("shareNote").textContent =
              "이미지 저장에 실패했어. 다시 시도해줘.";
          }
        });

        $("shareNativeBtn").addEventListener("click", async () => {
          try {
            await drawShareCard();
            const blob = await shareCanvasBlob();
            const g = currentGrade();
            const file = new File([blob], "MenherasStudyLog-status.png", {
              type: "image/png",
            });
            const shareText = `공부 안 하면 멘탈이 박살나는 타이머 쓰는 중\n현재 상태: ${g.name}\n오늘 순공: ${fmt(todaySeconds)}\n${SHARE_SITE_URL}`;

            if (
              navigator.share &&
              navigator.canShare &&
              navigator.canShare({ files: [file] })
            ) {
              await navigator.share({
                title: "Menhera's StudyLog 현재 상태",
                text: shareText,
                files: [file],
              });
              $("shareNote").textContent = "공유 완료!";
              return;
            }

            if (navigator.share) {
              await navigator.share({
                title: "Menhera's StudyLog 현재 상태",
                text: shareText,
                url: SHARE_SITE_URL,
              });
              $("shareNote").textContent =
                "이 브라우저는 이미지 공유를 지원하지 않아 링크와 상태 문구를 공유했어.";
              return;
            }

            $("shareDownloadBtn").click();
            $("shareNote").textContent =
              "이 브라우저는 시스템 공유를 지원하지 않아 이미지를 저장했어.";
          } catch (err) {
            if (err && err.name === "AbortError") return;
            $("shareNote").textContent =
              "공유 기능을 사용할 수 없어. 이미지 저장 버튼을 이용해줘.";
          }
        });

        const timerEl = $("timer"),
          damageEl = $("damageValue"),
          rateEl = $("rate"),
          barFill = $("barFill"),
          barText = $("barText");
        const btn = $("studyBtn"),
          status = $("status"),
          gradeEl = $("grade"),
          descEl = $("gradeDesc"),
          rangeEl = $("range"),
          portrait = $("portrait"),
          face = $("face");

        const grades = [
          {
            name: "평온",
            image: "assets/mental/calm.png",
            min: 0,
            max: 9999,
            color: "#70e6bd",
            goldRate: 0.08,
            desc: "아직 머릿속이 조용하다. 공부를 안 해도 죄책감이 직접 공격해오지는 않는 상태.",
          },
          {
            name: "동요",
            image: "assets/mental/uneasy.png",
            min: 10000,
            max: 29999,
            color: "#e3d76d",
            goldRate: 0.05,
            desc: "해야 할 일이 은근히 신경 쓰인다. 쉬고 있어도 머릿속 한구석에서 미세한 경고음이 울린다.",
          },
          {
            name: "균열",
            image: "assets/mental/crack.png",
            min: 30000,
            max: 54999,
            color: "#ffad61",
            goldRate: 0.03,
            desc: "집중하지 못한 시간이 체감되기 시작한다. 공부 생각이 반복적으로 침투하고 멘탈에 금이 간다.",
          },
          {
            name: "붕괴",
            image: "assets/mental/collapse.png",
            min: 55000,
            max: 79999,
            color: "#ff657c",
            goldRate: 0.015,
            desc: "쉬는 시간에도 마음이 편하지 않다. 순공 시간을 확보하지 않으면 죄의식이 온몸을 옥죄어 올 것 같다.",
          },
          {
            name: "멘헤라",
            image: "assets/mental/menhera.png",
            min: 80000,
            max: 100000,
            color: "#c175ff",
            goldRate: 0.005,
            desc: "누적 데미지 최상위 구간. 나는 사람이 아닌 짐승이다.",
          },
        ];

        const SAGE_STATE = {
          name: "대현자",
          image: "assets/mental/sage.png",
          min: 0,
          max: 0,
          color: "#8a74c7",
          goldRate: grades[0].goldRate * 1.3,
          desc: "나는 신이다. 공부 중 골드 획득량이 30% 증가한다.",
        };

        const MAX_STATE = {
          name: "정신분열",
          image: "assets/mental/max.png",
          min: MAX_DAMAGE,
          max: MAX_DAMAGE,
          color: "#6d5b73",
          goldRate: grades[grades.length - 1].goldRate,
          desc: "온전한 정신을 유지하기 힘들다.",
        };

        function gradeImageMarkup(grade, className = "") {
          const classes = ["mental-grade-img", className]
            .filter(Boolean)
            .join(" ");
          return `<img src="${grade.image}" alt="" class="${classes}" loading="eager" draggable="false">`;
        }

        function setGradeImage(target, grade, className = "") {
          if (!target) return;
          target.innerHTML = gradeImageMarkup(grade, className);
        }const gradeImageCache = new Map();

        function imageFromSrc(src) {
          return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () =>
              reject(new Error(`이미지 로드 실패: ${src.slice(0, 80)}`));
            img.src = src;
          });
        }

        function loadGradeImage(grade) {
          const key = grade.image;
          if (!gradeImageCache.has(key)) {
            const safeSrc = CANVAS_GRADE_IMAGE_DATA[key] || grade.image;
            gradeImageCache.set(key, imageFromSrc(safeSrc));
          }
          return gradeImageCache.get(key);
        }

        function uiIconMarkup(src, className = "") {
          const classes = ["ui-icon", className].filter(Boolean).join(" ");
          return `<img src="${src}" alt="" class="${classes}" draggable="false">`;
        }

        const SHOP_ITEMS = [
          {
            id: "mental-reset",
            name: "멘탈 완전회복권",
            image: "assets/ui/heal.png",
            tag: "RECOVERY / INSTANT",
            price: 3000,
            desc: "누적 데미지를 즉시 0으로 되돌린다. 돌이킬 수 없는 강을 건넌자를 위한 아이템",
            action() {
              setDamageTracked(0);
            },
          },
          {
            id: "recovery-boost-1h",
            name: "집중 회복 부스터",
            image: "assets/ui/boost.png",
            tag: "BOOST / 1 HOUR",
            price: 800,
            desc: "발동 후 현실시간 1시간 동안 공부 중 멘탈 회복속도가 2배가 된다. 공부를 멈추거나 브라우저를 닫아도 지속시간은 계속 흐른다. 이미 활성화 중이면 1시간이 추가 연장된다.",
            action() {
              const now = Date.now();
              recoveryBoostUntil =
                Math.max(now, recoveryBoostUntil) + 60 * 60 * 1000;
            },
          },
        ];
        function todayKey() {
          const d = new Date();
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        }
        function rollover() {
          const now = todayKey();
          if (now !== dayKey) {
            records[dayKey] = Math.max(
              Number(records[dayKey] || 0),
              todaySeconds,
            );
            dayKey = now;
            todaySeconds = 0;
            if (
              !Object.prototype.hasOwnProperty.call(dailyDamageChanges, dayKey)
            ) {
              dailyDamageChanges[dayKey] = 0;
            }
          }
        }
        function gradeIndexFor(value, direction = 0) {
          value = Math.max(0, Math.min(MAX_DAMAGE, Number(value) || 0));
          let idx = 0;
          for (let i = 0; i < grades.length; i++)
            if (value >= grades[i].min) idx = i;
          // 경계에서 아래로 이동할 때는 바로 이전 등급 구간의 획득률을 적용한다.
          if (
            direction < 0 &&
            idx > 0 &&
            Math.abs(value - grades[idx].min) < 1e-9
          )
            idx--;
          return idx;
        }
        function gradeFor(value) {
          value = Math.max(0, Math.min(MAX_DAMAGE, Number(value) || 0));
          if (value <= 1e-9) return SAGE_STATE;
          if (value >= MAX_DAMAGE - 1e-9) return MAX_STATE;
          return grades[gradeIndexFor(value, 0)];
        }
        function goldRateForDamage(value) {
          return value <= 1e-9
            ? SAGE_STATE.goldRate
            : grades[gradeIndexFor(value, 0)].goldRate;
        }

        function advanceProgress(seconds, damageRate, earnGold = true) {
          const damageBeforeAdvance = damage;
          let remaining = Math.max(0, Number(seconds) || 0);
          let earned = 0;
          let guard = 0;
          while (remaining > 1e-7 && guard++ < 32) {
            const idx = gradeIndexFor(damage, damageRate);
            const g = grades[idx];

            if (Math.abs(damageRate) < 1e-12) {
              earned += goldRateForDamage(damage) * remaining;
              remaining = 0;
              break;
            }

            if (damageRate > 0) {
              if (damage >= MAX_DAMAGE - 1e-9) {
                damage = MAX_DAMAGE;
                earned += grades[grades.length - 1].goldRate * remaining;
                remaining = 0;
                break;
              }
              const boundary =
                idx < grades.length - 1 ? grades[idx + 1].min : MAX_DAMAGE;
              const tToBoundary = Math.max(0, (boundary - damage) / damageRate);
              if (tToBoundary >= remaining || tToBoundary < 1e-12) {
                if (tToBoundary < 1e-12) {
                  damage = Math.min(
                    MAX_DAMAGE,
                    damage + damageRate * Math.min(remaining, 1e-6),
                  );
                  earned += g.goldRate * Math.min(remaining, 1e-6);
                  remaining -= Math.min(remaining, 1e-6);
                } else {
                  earned += g.goldRate * remaining;
                  damage = Math.min(
                    MAX_DAMAGE,
                    damage + damageRate * remaining,
                  );
                  remaining = 0;
                }
              } else {
                earned += g.goldRate * tToBoundary;
                damage = boundary;
                remaining -= tToBoundary;
              }
            } else {
              if (damage <= 1e-9) {
                damage = 0;
                earned += SAGE_STATE.goldRate * remaining;
                remaining = 0;
                break;
              }
              const boundary = grades[idx].min;
              const tToBoundary = Math.max(
                0,
                (damage - boundary) / -damageRate,
              );
              if (tToBoundary >= remaining) {
                earned += g.goldRate * remaining;
                damage = Math.max(0, damage + damageRate * remaining);
                remaining = 0;
              } else {
                earned += g.goldRate * tToBoundary;
                damage = boundary;
                remaining -= tToBoundary;
                if (tToBoundary < 1e-12) {
                  const tiny = Math.min(remaining, 1e-6);
                  const prev = grades[Math.max(0, idx)];
                  earned += prev.goldRate * tiny;
                  damage = Math.max(0, damage + damageRate * tiny);
                  remaining -= tiny;
                }
              }
            }
          }
          damage = Math.max(0, Math.min(MAX_DAMAGE, damage));
          recordDamageDelta(damage - damageBeforeAdvance);
          gold = Math.max(0, gold + (earnGold ? earned : 0));
          return earnGold ? earned : 0;
        }

        function applyElapsed() {
          const now = Date.now();
          const elapsed = Math.max(0, (now - lastTs) / 1000);
          rollover();

          if (studying && elapsed > 0) {
            // 부스터 만료 시점이 경과 구간 안에 있으면 정확히 둘로 나눠 계산한다.
            if (recoveryBoostUntil > lastTs && recoveryBoostUntil < now) {
              const boostedSeconds = (recoveryBoostUntil - lastTs) / 1000;
              const normalSeconds = (now - recoveryBoostUntil) / 1000;
              advanceProgress(boostedSeconds, studyRate() * 2, true);
              advanceProgress(normalSeconds, studyRate(), true);
            } else {
              const rate = isRecoveryBoostActive(lastTs)
                ? studyRate() * 2
                : studyRate();
              advanceProgress(elapsed, rate, true);
            }
            todaySeconds += elapsed;
          } else if (elapsed > 0) {
            advanceProgress(elapsed, IDLE_RATE, false);
          }
          lastTs = now;
        }
        function settleOffline(seconds, showPopup = true) {
          seconds = Math.max(0, Number(seconds) || 0);
          const before = damage;
          const beforeGrade = gradeFor(before);
          studying = false; // 오프라인에서는 순공 모드가 절대 유지되지 않음
          rollover();
          advanceProgress(seconds, IDLE_RATE, false);
          const applied = damage - before;
          const afterGrade = gradeFor(damage);
          lastTs = Date.now();
          if (showPopup && seconds >= 1) {
            $("offlineElapsed").textContent = fmt(seconds);
            $("offlineDamage").textContent =
              "+" + Math.round(applied).toLocaleString("ko-KR");
            $("offlineTotalDamage").textContent =
              `${Math.round(damage).toLocaleString("ko-KR")} / ${MAX_DAMAGE.toLocaleString("ko-KR")}`;
            const pct = (damage / MAX_DAMAGE) * 100;
            $("offlineTotalPercent").textContent = `${pct.toFixed(1)}%`;
            $("offlineMiniFill").style.width = pct + "%";
            $("offlineMiniFill").style.background =
              `linear-gradient(90deg, ${afterGrade.color}, ${afterGrade.color}cc)`;
            setGradeImage($("offlineFace"), afterGrade, "offline-main");
            const worsened = beforeGrade.name !== afterGrade.name;
            const severityText = worsened ? "등급 악화 감지" : "등급 유지";
            const severityStyle = `color:${worsened ? "#9d4d58" : "#4c7562"};border-color:${worsened ? "#d4a1a8" : "#b8d0c0"};background:${worsened ? "#fff2f4" : "#f2fbf6"};`;
            $("offlineModal").showModal();
          }
        }
        function fmt(sec) {
          sec = Math.floor(sec);
          const h = Math.floor(sec / 3600),
            m = Math.floor((sec % 3600) / 60),
            s = sec % 60;
          return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        }
        function currentGrade() {
          return gradeFor(damage);
        }
        function render() {
          timerEl.textContent = fmt(todaySeconds);
          damageEl.textContent = Math.round(damage).toLocaleString("ko-KR");
          const pct = (damage / MAX_DAMAGE) * 100;
          barFill.style.width = pct + "%";
          barText.textContent = pct.toFixed(1) + "%";
          const g = currentGrade();
          $("goldValue").textContent = Math.floor(gold).toLocaleString("ko-KR");
          barFill.style.background = `linear-gradient(90deg, ${g.color}, ${g.color}cc)`;
          barFill.style.color = g.color;
          portrait.style.color = g.color;
          portrait.style.borderColor = g.color + "66";
          setGradeImage(face, g, "main");
          gradeEl.textContent = g.name;
          gradeEl.style.color = g.color;
          descEl.textContent = g.desc;
          rangeEl.textContent =
            g === SAGE_STATE
              ? "SPECIAL STATE · damage 0"
              : g === MAX_STATE
                ? `SPECIAL STATE · damage ${MAX_DAMAGE.toLocaleString()}`
                : `${g.min.toLocaleString()} – ${g.max.toLocaleString()} damage`;
          const effectiveStudyRate = boostedStudyRate();
          rateEl.textContent = studying
            ? `${effectiveStudyRate.toFixed(3)} / sec${isRecoveryBoostActive() ? " · BOOST ×2" : ""}`
            : `+${IDLE_RATE.toFixed(3)} / sec`;
          rateEl.className = "rate " + (studying ? "down" : "up");

          const effects = [];
          if (g === SAGE_STATE) {
            effects.push(
              `<div class="effect-chip">${gradeImageMarkup(SAGE_STATE, "effect-grade-img")} 대현자 · 공부 중 골드 +30%</div>`,
            );
          }
          if (isRecoveryBoostActive()) {
            effects.push(
              `<div class="effect-chip boost">${uiIconMarkup("assets/ui/boost.png", "effect-ui-icon")} 회복속도 ×2 <span class="effect-time">${fmtCountdown(boosterRemainingMs())}</span></div>`,
            );
          }
          $("activeEffects").innerHTML = effects.join("");
          btn.textContent = studying ? "공부 종료" : "공부 시작";
          btn.classList.toggle("active", studying);
          status.textContent = studying
            ? g === SAGE_STATE
              ? "대현자 집중 모드 — 데미지 0 유지 / 골드 획득 +30%"
              : g === MAX_STATE
                ? "정신분열 상태 — 공부 중 / 최대 데미지에서 회복 중"
                : "집중 모드 — 순공시간 증가 / 멘탈 데미지 회복 중"
            : g === SAGE_STATE
              ? "대현자 상태 — 현재 데미지 0"
              : g === MAX_STATE
                ? "정신분열 상태 — 누적 데미지 MAX"
                : "현재 비공부 상태 — 멘탈 데미지 적용 중";
          $("goalBtnHours").textContent = `${goalHours}시간`;
          const restHours = 24 - goalHours;
          const ratio = goalHours >= 24 ? 0 : restHours / goalHours;
          $("balanceInfo").innerHTML =
            goalHours >= 24
              ? `밸런스 기준: 하루 <b>24시간 공부</b> 목표에서는 비공부 시간이 0시간이므로 공부 중 데미지 변화량은 <b>0 / sec</b>로 설정됩니다.`
              : `밸런스 기준: 하루 ${restHours}시간 비공부 + <b>${goalHours}시간 공부</b> 시 누적 데미지 순변화 ≈ 0<br>현재 기본 회복 속도: <b>${studyRate().toFixed(3)} / sec</b> (비공부 데미지의 ${ratio.toFixed(2)}배)${isRecoveryBoostActive() ? `<br><span class="inline-icon-text">${uiIconMarkup("assets/ui/boost.png", "inline-ui-icon")} 부스터 활성 중: 공부 시 <b>${(studyRate() * 2).toFixed(3)} / sec</b></span>` : ""}`;
          renderHistory();
        }
        function save() {
          records[dayKey] = Math.max(
            Number(records[dayKey] || 0),
            todaySeconds,
          );
          localStorage.setItem(
            "mentalStudyStateV1",
            JSON.stringify({
              damage,
              studying,
              dayKey,
              todaySeconds,
              records,
              dailyDamageChanges,
              lastTs,
              goalHours,
              gold,
              recoveryBoostUntil,
            }),
          );
          $("saveState").textContent =
            "마지막 저장 " +
            new Date().toLocaleTimeString("ko-KR", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
        }
        function renderHistory() {
          const all = {
            ...records,
            [dayKey]: Math.max(Number(records[dayKey] || 0), todaySeconds),
          };
          const items = Object.entries(all).sort((a, b) =>
            b[0].localeCompare(a[0]),
          );
          const preview = items.slice(0, 5);
          $("historyPreview").innerHTML = preview.length
            ? preview
                .map(
                  ([d, s]) =>
                    `<div class="history-item"><div class="date">${d}${d === dayKey ? " · TODAY" : ""}</div><div class="time">${fmt(s)}</div></div>`,
                )
                .join("")
            : `<div class="history-empty">아직 기록이 없습니다.<br>공부 시작 버튼을 누르면 첫 기록이 생성됩니다.</div>`;
        }

        const STUDY_BACKUP_FORMAT = "menheras-studylog-backup";
        const STUDY_BACKUP_VERSION = 1;

        function plainNumberMap(
          value,
          { min = -Infinity, max = Infinity } = {},
        ) {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return {};
          }
          const result = {};
          for (const [key, raw] of Object.entries(value)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
            const num = Number(raw);
            if (!Number.isFinite(num)) continue;
            result[key] = Math.max(min, Math.min(max, num));
          }
          return result;
        }

        function createStudyBackup() {
          applyElapsed();
          save();

          return {
            format: STUDY_BACKUP_FORMAT,
            version: STUDY_BACKUP_VERSION,
            exportedAt: new Date().toISOString(),
            state: {
              damage,
              dayKey,
              todaySeconds,
              records: { ...records },
              dailyDamageChanges: { ...dailyDamageChanges },
              goalHours,
              gold,
              recoveryBoostUntil,
            },
          };
        }

        function validateStudyBackup(raw) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error("JSON 최상위 형식이 올바르지 않아.");
          }

          // 정식 백업 포맷을 우선 사용하고, state 객체만 있는 간단한 파일도 허용한다.
          const source =
            raw.format === STUDY_BACKUP_FORMAT && raw.state
              ? raw.state
              : raw.state && typeof raw.state === "object"
                ? raw.state
                : raw;

          if (!source || typeof source !== "object" || Array.isArray(source)) {
            throw new Error("StudyLog 상태 데이터를 찾을 수 없어.");
          }

          const importedDayKey =
            typeof source.dayKey === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(source.dayKey)
              ? source.dayKey
              : todayKey();

          const importedRecords = plainNumberMap(source.records, {
            min: 0,
            max: 24 * 60 * 60,
          });

          const importedDamageChanges = plainNumberMap(
            source.dailyDamageChanges,
            {
              min: -MAX_DAMAGE,
              max: MAX_DAMAGE,
            },
          );

          const importedTodaySeconds = Math.max(
            0,
            Math.min(
              24 * 60 * 60,
              Number.isFinite(Number(source.todaySeconds))
                ? Number(source.todaySeconds)
                : Number(importedRecords[importedDayKey] || 0),
            ),
          );

          const result = {
            damage: Math.max(
              0,
              Math.min(
                MAX_DAMAGE,
                Number.isFinite(Number(source.damage))
                  ? Number(source.damage)
                  : 0,
              ),
            ),
            dayKey: importedDayKey,
            todaySeconds: importedTodaySeconds,
            records: importedRecords,
            dailyDamageChanges: importedDamageChanges,
            goalHours: Math.max(
              1,
              Math.min(
                24,
                Number.isFinite(Number(source.goalHours))
                  ? Number(source.goalHours)
                  : DEFAULT_GOAL_HOURS,
              ),
            ),
            gold: Math.max(
              0,
              Number.isFinite(Number(source.gold)) ? Number(source.gold) : 0,
            ),
            recoveryBoostUntil: Math.max(
              0,
              Number.isFinite(Number(source.recoveryBoostUntil))
                ? Number(source.recoveryBoostUntil)
                : 0,
            ),
          };

          // 구버전 백업에 멘탈 변화 기록이 없어도 정상 작동하게 한다.
          if (
            !Object.prototype.hasOwnProperty.call(
              result.dailyDamageChanges,
              result.dayKey,
            )
          ) {
            result.dailyDamageChanges[result.dayKey] = 0;
          }

          return result;
        }

        function applyImportedStudyState(imported) {
          damage = imported.damage;
          studying = false;
          dayKey = imported.dayKey;
          todaySeconds = imported.todaySeconds;
          records = { ...imported.records };
          dailyDamageChanges = { ...imported.dailyDamageChanges };
          goalHours = imported.goalHours;
          gold = imported.gold;
          recoveryBoostUntil = imported.recoveryBoostUntil;

          // 백업 시점부터 지금까지를 오프라인 시간으로 오인하지 않도록 한다.
          lastTs = Date.now();

          rollover();
          save();
          render();
          fillModal();
          syncAdminFields();
        }

        function setHistoryDataMessage(message, type = "") {
          const el = $("historyDataMessage");
          if (!el) return;
          el.textContent = message;
          el.className = `history-data-message${type ? " " + type : ""}`;
        }

        function exportStudyDataFile() {
          try {
            const backup = createStudyBackup();
            const blob = new Blob([JSON.stringify(backup, null, 2)], {
              type: "application/json;charset=utf-8",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `MenherasStudyLog_backup_${todayKey()}.json`;
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setHistoryDataMessage("백업 JSON 파일을 저장했어.", "ok");
          } catch (err) {
            console.error("데이터 내보내기 실패:", err);
            setHistoryDataMessage("데이터 내보내기에 실패했어.", "bad");
          }
        }

        async function importStudyDataFile(file) {
          if (!file) return;
          try {
            const fileText = await file.text();
            const raw = JSON.parse(fileText);
            const imported = validateStudyBackup(raw);

            const recordCount = Object.keys(imported.records).length;
            const damageCount = Object.keys(imported.dailyDamageChanges).length;

            const confirmed = confirm(
              `이 백업 데이터로 현재 기록을 덮어쓸까요?\n\n` +
                `순공 기록: ${recordCount}일\n` +
                `멘탈 변화 기록: ${damageCount}일\n` +
                `현재 멘탈 데미지: ${Math.round(imported.damage).toLocaleString("ko-KR")}\n\n` +
                `현재 브라우저의 기존 데이터는 덮어써집니다.`,
            );
            if (!confirmed) {
              setHistoryDataMessage("불러오기를 취소했어.");
              return;
            }

            applyImportedStudyState(imported);
            setHistoryDataMessage("백업 데이터를 정상적으로 불러왔어.", "ok");
          } catch (err) {
            console.error("데이터 불러오기 실패:", err);
            setHistoryDataMessage(
              `불러오기 실패: ${err?.message || "올바른 JSON 파일인지 확인해줘."}`,
              "bad",
            );
          } finally {
            $("studyDataImportInput").value = "";
          }
        }

        function fillModal() {
          const all = {
            ...records,
            [dayKey]: Math.max(Number(records[dayKey] || 0), todaySeconds),
          };
          const items = Object.entries(all).sort((a, b) =>
            b[0].localeCompare(a[0]),
          );
          $("records").innerHTML =
            (items.length
              ? items
                  .map(([d, s]) => {
                    const hasDelta = hasDamageChangeRecord(d);
                    const delta = hasDelta
                      ? Number(dailyDamageChanges[d]) || 0
                      : null;
                    const deltaClass = !hasDelta
                      ? "unknown"
                      : delta > 0
                        ? "up"
                        : delta < 0
                          ? "down"
                          : "zero";
                    const deltaText = hasDelta
                      ? `멘탈 ${signedDamageText(delta)}`
                      : "멘탈 기록 없음";
                    return `<div class="record-row"><div class="record-date">${d}${d === dayKey ? " · 오늘" : ""}</div><div class="record-summary"><div class="record-time">${fmt(s)}</div><div class="record-damage-change ${deltaClass}">${deltaText}</div></div></div>`;
                  })
                  .join("")
              : `<div class="history-empty">기록 없음</div>`) +
            `<div class="history-data-zone">
              <div class="danger-zone" style="margin:0;padding:0;border:0">
                <button class="reset-link" id="resetAll">전체 데이터 초기화</button>
              </div>
              <div class="history-data-actions">
                <button class="history-data-btn" id="exportStudyData">데이터 내보내기</button>
                <button class="history-data-btn" id="importStudyData">데이터 불러오기</button>
              </div>
              <div id="historyDataMessage" class="history-data-message"></div>
            </div>`;
          $("resetAll").onclick = () => {
            if (confirm("정말 모든 기록과 데미지를 초기화할까요?")) {
              // 기존 구현은 localStorage를 지운 뒤 location.reload()를 호출했는데,
              // beforeunload 핸들러가 직전에 현재 상태를 다시 save()해서
              // 삭제한 데이터가 곧바로 복구되는 문제가 있었다.
              // 여기서는 메모리 상태까지 직접 초기화한 뒤 저장하므로
              // unload/save 경쟁 없이 확실하게 초기화된다.
              applyElapsed();

              damage = 0;
              studying = false;
              dayKey = todayKey();
              todaySeconds = 0;
              records = {};
              dailyDamageChanges = { [dayKey]: 0 };
              lastTs = Date.now();
              goalHours = DEFAULT_GOAL_HOURS;
              gold = 0;
              recoveryBoostUntil = 0;

              save();
              render();
              fillModal();
            }
          };

          $("exportStudyData").onclick = exportStudyDataFile;
          $("importStudyData").onclick = () => {
            $("studyDataImportInput").click();
          };
        }

        function renderShop() {
          $("shopGoldValue").textContent =
            Math.floor(gold).toLocaleString("ko-KR");
          $("goldRateTable").innerHTML =
            `<tr><th>멘탈 등급</th><th>초당 골드</th></tr>` +
            [SAGE_STATE, ...grades, MAX_STATE]
              .map(
                (x) =>
                  `<tr><td><span class="grade-image-inline">${gradeImageMarkup(x, "mini")}<span style="color:${x.color};font-weight:900">${x.name}</span></span></td><td>+${x.goldRate.toFixed(3)} G/s${x === SAGE_STATE ? " · +30%" : ""}</td></tr>`,
              )
              .join("");

          $("shopGrid").innerHTML = SHOP_ITEMS.map((item) => {
            const price = item.price;
            const affordable = gold >= price;
            return `<div class="shop-item">
        <div class="shop-icon">${uiIconMarkup(item.image, "shop-item-icon-img")}</div>
        <div class="shop-item-name">${item.name}</div>
        <div class="shop-item-tag">${item.tag}</div>
        <div class="shop-item-desc">${item.desc}
          ${
            item.id === "recovery-boost-1h" && isRecoveryBoostActive()
              ? `<br><br><b class="inline-icon-text">${uiIconMarkup("assets/ui/boost.png", "inline-ui-icon")} 현재 활성 중 · 남은 시간 ${fmtCountdown(boosterRemainingMs())}</b>`
              : ""
          }
        </div>
        <div class="shop-item-footer">
          <div class="shop-price">${price.toLocaleString("ko-KR")} G</div>
          <button class="buy-btn" data-buy="${item.id}" ${affordable ? "" : "disabled"}>${affordable ? "구매" : "골드 부족"}</button>
        </div>
      </div>`;
          }).join("");

          document.querySelectorAll("[data-buy]").forEach((b) =>
            b.addEventListener("click", () => {
              const item = SHOP_ITEMS.find((x) => x.id === b.dataset.buy);
              if (!item) return;
              applyElapsed();
              const price = item.price;
              if (gold < price) {
                showShopMessage(
                  "골드가 부족해. 멘탈 등급을 좋은 상태로 유지하면 더 빠르게 모을 수 있어.",
                  false,
                );
                renderShop();
                render();
                return;
              }
              if (
                !confirm(
                  `${item.name}을 ${price.toLocaleString("ko-KR")} G에 구매해서 즉시 사용할까?`,
                )
              )
                return;
              gold -= price;
              item.action();
              save();
              render();
              renderShop();
              const successText =
                item.id === "mental-reset"
                  ? `${item.name} 사용 완료! 누적 데미지가 0으로 회복됐어.`
                  : `${item.name} 발동! 앞으로 ${fmtCountdown(boosterRemainingMs())} 동안 공부 중 멘탈 회복속도가 2배야.`;
              showShopMessage(successText, true);
            }),
          );
        }
        function showShopMessage(message, ok = true) {
          const el = $("shopMessage");
          el.textContent = message;
          el.className = `shop-message show ${ok ? "ok" : "bad"}`;
        }
        $("shopOpen").addEventListener("click", () => {
          applyElapsed();
          render();
          renderShop();
          $("shopMessage").className = "shop-message";
          $("shopModal").showModal();
        });
        $("closeShop").addEventListener("click", () => $("shopModal").close());
        $("shopModal").addEventListener("click", (e) => {
          if (e.target === $("shopModal")) $("shopModal").close();
        });

        function renderGoalOptions() {
          $("goalGrid").innerHTML = Array.from({ length: 24 }, (_, i) => i + 1)
            .map(
              (h) =>
                `<button class="goal-option ${h === goalHours ? "selected" : ""}" data-goal="${h}">${h}h</button>`,
            )
            .join("");
          $("goalCurrentText").textContent = `${goalHours}시간 / 일`;
          const rest = 24 - goalHours;
          $("goalBalanceText").innerHTML =
            goalHours >= 24
              ? `24시간 목표에서는 하루 비공부 시간이 0시간이므로, 균형을 위해 공부 중 데미지 변화량이 <b>0 / sec</b>가 됩니다.`
              : `하루 ${rest}시간 동안의 비공부 데미지를 ${goalHours}시간 공부로 상쇄하도록 회복 속도를 <b>${studyRate().toFixed(3)} / sec</b>로 자동 설정합니다.`;
          document.querySelectorAll("[data-goal]").forEach((el) =>
            el.addEventListener("click", () => {
              applyElapsed();
              goalHours = Number(el.dataset.goal);
              save();
              render();
              renderGoalOptions();
            }),
          );
        }
        $("goalBtn").addEventListener("click", () => {
          renderGoalOptions();
          $("goalModal").showModal();
        });
        $("closeGoal").addEventListener("click", () => $("goalModal").close());
        $("goalModal").addEventListener("click", (e) => {
          if (e.target === $("goalModal")) $("goalModal").close();
        });

        btn.addEventListener("click", () => {
          applyElapsed();
          studying = !studying;
          save();
          render();
        });
        $("resetTodayBtn").addEventListener("click", () => {
          if (confirm("오늘의 순공 타이머만 0으로 초기화할까요?")) {
            applyElapsed();
            todaySeconds = 0;
            records[dayKey] = 0;
            save();
            render();
          }
        });

        $("studyDataImportInput").addEventListener("change", async (e) => {
          const file = e.target.files && e.target.files[0];
          await importStudyDataFile(file);
        });

        $("historyBtn").addEventListener("click", () => {
          fillModal();
          $("historyModal").showModal();
        });
        $("closeModal").addEventListener("click", () =>
          $("historyModal").close(),
        );
        $("historyModal").addEventListener("click", (e) => {
          if (e.target === $("historyModal")) $("historyModal").close();
        });
        $("closeOffline").addEventListener("click", () =>
          $("offlineModal").close(),
        );
        $("offlineConfirm").addEventListener("click", () =>
          $("offlineModal").close(),
        );
        $("offlineModal").addEventListener("click", (e) => {
          if (e.target === $("offlineModal")) $("offlineModal").close();
        });

        // 관리자 패널
        const adminModal = $("adminModal");
        const ADMIN_REVEAL_CLICKS = 5;
        const ADMIN_CLICK_WINDOW_MS = 2000;
        const ADMIN_VISIBLE_MS = 20000;
        let adminSecretClicks = [];
        let adminRevealTimer = null;

        function syncAdminFields() {
          $("adminDamage").value = Math.round(damage);
          $("adminTodaySeconds").value = Math.floor(todaySeconds);
          $("adminGold").value = Math.floor(gold);
          if ($("adminBoostStatus"))
            $("adminBoostStatus").textContent = isRecoveryBoostActive()
              ? `활성 · 남은 시간 ${fmtCountdown(boosterRemainingMs())}`
              : "비활성";
        }

        function setAdminMenuVisible(visible) {
          const btn = $("adminMenuOpen");
          if (!btn) return;
          btn.classList.toggle("admin-menu-item-hidden", !visible);
          btn.classList.toggle("admin-menu-item-visible", visible);
          btn.setAttribute("aria-hidden", visible ? "false" : "true");
        }

        function revealAdminMenuTemporarily() {
          setAdminMenuVisible(true);
          clearTimeout(adminRevealTimer);
          adminRevealTimer = setTimeout(() => {
            setAdminMenuVisible(false);
          }, ADMIN_VISIBLE_MS);
        }

        function openAdminPanelDirect() {
          setUtilityMenu(false);
          syncAdminFields();
          adminModal.showModal();
        }

        $("saveState").addEventListener("click", () => {
          const now = Date.now();
          adminSecretClicks = adminSecretClicks.filter(
            (t) => now - t <= ADMIN_CLICK_WINDOW_MS,
          );
          adminSecretClicks.push(now);

          if (adminSecretClicks.length >= ADMIN_REVEAL_CLICKS) {
            adminSecretClicks = [];
            revealAdminMenuTemporarily();
          }
        });

        $("adminMenuOpen").addEventListener("click", openAdminPanelDirect);

        $("closeAdminPanel").addEventListener("click", () =>
          adminModal.close(),
        );
        adminModal.addEventListener("click", (e) => {
          if (e.target === adminModal) adminModal.close();
        });
        $("adminBoost1h").addEventListener("click", () => {
          applyElapsed();
          recoveryBoostUntil =
            Math.max(Date.now(), recoveryBoostUntil) + 3600000;
          save();
          render();
          syncAdminFields();
        });
        $("adminBoost5m").addEventListener("click", () => {
          applyElapsed();
          recoveryBoostUntil =
            Math.max(Date.now(), recoveryBoostUntil) + 300000;
          save();
          render();
          syncAdminFields();
        });
        $("adminBoostExpire").addEventListener("click", () => {
          applyElapsed();
          recoveryBoostUntil = 0;
          save();
          render();
          syncAdminFields();
        });
        $("applyGold").addEventListener("click", () => {
          applyElapsed();
          gold = Math.max(0, Number($("adminGold").value) || 0);
          save();
          render();
          syncAdminFields();
        });
        document.querySelectorAll("[data-gold]").forEach((b) =>
          b.addEventListener("click", () => {
            applyElapsed();
            gold = Math.max(0, gold + Number(b.dataset.gold));
            save();
            render();
            syncAdminFields();
          }),
        );
        $("applyDamage").addEventListener("click", () => {
          applyElapsed();
          setDamageTracked(Number($("adminDamage").value) || 0);
          save();
          render();
          syncAdminFields();
        });
        document.querySelectorAll("[data-dmg]").forEach((b) =>
          b.addEventListener("click", () => {
            applyElapsed();
            setDamageTracked(damage + Number(b.dataset.dmg));
            save();
            render();
            syncAdminFields();
          }),
        );
        $("jumpGrade").addEventListener("click", () => {
          applyElapsed();
          setDamageTracked(Number($("gradeJump").value));
          save();
          render();
          syncAdminFields();
        });
        $("applyTodaySeconds").addEventListener("click", () => {
          applyElapsed();
          todaySeconds = Math.max(0, Number($("adminTodaySeconds").value) || 0);
          records[dayKey] = todaySeconds;
          save();
          render();
          syncAdminFields();
        });
        document.querySelectorAll("[data-time]").forEach((b) =>
          b.addEventListener("click", () => {
            applyElapsed();
            todaySeconds = Math.max(0, todaySeconds + Number(b.dataset.time));
            records[dayKey] = todaySeconds;
            save();
            render();
            syncAdminFields();
          }),
        );
        $("forceStudy").addEventListener("click", () => {
          applyElapsed();
          studying = true;
          save();
          render();
          syncAdminFields();
        });
        $("forceIdle").addEventListener("click", () => {
          applyElapsed();
          studying = false;
          save();
          render();
          syncAdminFields();
        });
        document.querySelectorAll("[data-elapsed]").forEach((b) =>
          b.addEventListener("click", () => {
            const sec = Number(b.dataset.elapsed);
            if (studying) {
              advanceProgress(
                sec,
                isRecoveryBoostActive() ? studyRate() * 2 : studyRate(),
                true,
              );
            } else {
              advanceProgress(sec, IDLE_RATE, false);
            }
            if (studying) todaySeconds += sec;
            records[dayKey] = Math.max(
              Number(records[dayKey] || 0),
              todaySeconds,
            );
            save();
            render();
            syncAdminFields();
          }),
        );

        $("generateDummyDamage").addEventListener("click", () => {
          applyElapsed();

          const days = Math.max(
            2,
            Math.min(
              90,
              Math.floor(Number($("adminDummyDamageDays").value) || 14),
            ),
          );
          $("adminDummyDamageDays").value = String(days);

          // 재현 가능한 파형을 사용해 증가/감소가 모두 보이게 만든다.
          for (let i = days - 1; i >= 0; i--) {
            const key = dateKeyDaysAgo(i);
            const index = days - 1 - i;
            let value = Math.round(
              Math.sin(index * 1.18) * 7200 + Math.cos(index * 0.53) * 2800,
            );

            // 0만 계속 나오는 구간을 피하고 시각적 변화가 확실하도록 보정.
            if (Math.abs(value) < 700) {
              value = index % 2 === 0 ? 1200 : -1200;
            }
            dailyDamageChanges[key] = value;
          }

          // 오늘 데이터도 즉시 기록된 것으로 보장.
          if (!hasDamageChangeRecord(dayKey)) {
            dailyDamageChanges[dayKey] = 0;
          }

          save();
          render();
          syncAdminFields();
          $("adminDummyDamageMsg").textContent =
            `최근 ${days}일의 더미 멘탈 변화 데이터를 생성했어. 공유 카드에서 바로 테스트할 수 있어.`;
        });

        document.querySelectorAll("[data-offline]").forEach((b) =>
          b.addEventListener("click", () => {
            $("adminOfflineMinutes").value = Number(b.dataset.offline);
          }),
        );
        $("simulateOffline").addEventListener("click", () => {
          applyElapsed();
          const minutes = Math.max(
            0,
            Number($("adminOfflineMinutes").value) || 0,
          );
          settleOffline(minutes * 60, true);
          save();
          render();
          syncAdminFields();
        });

        // 재접속 정산: 마지막 저장 이후의 시간은 항상 비공부 시간으로 계산한다.
        // 이전 세션에서 공부 중이었다 하더라도 페이지가 다시 열리면 자동 종료된다.
        const startupNow = Date.now();
        const offlineElapsed = Math.max(0, (startupNow - lastTs) / 1000);
        studying = false;
        if (offlineElapsed >= 1) settleOffline(offlineElapsed, true);
        else lastTs = startupNow;
        render();
        save();

        setInterval(() => {
          applyElapsed();
          render();
        }, 250);
        setInterval(save, 5000);

        const tabLockHeartbeat = setInterval(() => {
          const current = readTabLock();
          if (current && current.id !== tabId && lockIsFresh(current)) {
            clearInterval(tabLockHeartbeat);
            location.reload();
            return;
          }
          localStorage.setItem(
            TAB_LOCK_KEY,
            JSON.stringify({ id: tabId, ts: Date.now() }),
          );
        }, TAB_LOCK_HEARTBEAT);

        window.addEventListener("storage", (event) => {
          if (event.key !== TAB_LOCK_KEY || !event.newValue) return;
          try {
            const incoming = JSON.parse(event.newValue);
            if (incoming.id !== tabId && lockIsFresh(incoming))
              location.reload();
          } catch {}
        });
        window.addEventListener("beforeunload", () => {
          applyElapsed();
          studying = false; // 창 닫기/새로고침 시 공부 모드 자동 종료
          lastTs = Date.now();
          save();
          const current = readTabLock();
          if (current && current.id === tabId)
            localStorage.removeItem(TAB_LOCK_KEY);
        });
        document.addEventListener("visibilitychange", () => {
          // 단순 탭 전환/최소화는 공부 모드를 끄지 않는다. 실제 unload 시에만 자동 종료.
          if (document.hidden) {
            applyElapsed();
            save();
          } else {
            applyElapsed();
            render();
          }
        });
      })();
    