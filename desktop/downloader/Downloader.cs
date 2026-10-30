// EVE 辅助工具桌面版下载器：网页上只提供这个小程序，运行后从 GitHub Releases 下载最新安装包并启动安装。
// GitHub 连不上时依次改用镜像。只用 .NET Framework 4.x 自带的库（Windows 10 / 11 自带），C# 5 语法，便于用 csc / mcs 直接编译。
using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("EVE 辅助工具下载器")]
[assembly: System.Reflection.AssemblyProduct("EVE 辅助工具")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

static class Program
{
    const string Repo = "aaassddd812/eve-tool-desktop";
    const string Asset = "EVE-Tool-Setup.exe";
    static readonly string Direct = "https://github.com/" + Repo + "/releases/latest/download/" + Asset;
    // 依次尝试：GitHub 直连，然后是公共加速镜像（国内访问 GitHub 慢或连不上时）
    static readonly string[] Sources = { Direct, "https://ghfast.top/" + Direct, "https://gh-proxy.com/" + Direct };
    static readonly bool Zh = CultureInfo.CurrentUICulture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
    static string T(string zh, string en) { return Zh ? zh : en; }

    [STAThread]
    static void Main()
    {
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;   // TLS 1.2
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm());
    }

    class MainForm : Form
    {
        readonly Label status = new Label();
        readonly Label detail = new Label();
        readonly ProgressBar bar = new ProgressBar();
        readonly Button action = new Button();
        volatile bool cancel;
        bool failed;

        public MainForm()
        {
            Text = T("EVE 辅助工具 · 下载器", "EVE Tool · Downloader");
            Font = new Font("Microsoft YaHei UI", 9F);
            AutoScaleMode = AutoScaleMode.Font;
            ClientSize = new Size(440, 150);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            status.SetBounds(20, 18, 400, 22);
            status.Font = new Font(Font.FontFamily, 10.5F, FontStyle.Bold);
            status.Text = T("正在连接 GitHub…", "Connecting to GitHub…");
            bar.SetBounds(20, 48, 400, 16);
            detail.SetBounds(20, 70, 400, 34);
            detail.ForeColor = Color.DimGray;
            action.SetBounds(330, 110, 90, 28);
            action.Text = T("取消", "Cancel");
            action.Click += delegate
            {
                if (failed) { Process.Start("https://github.com/" + Repo + "/releases/latest"); Close(); }
                else { cancel = true; Close(); }
            };
            Controls.AddRange(new Control[] { status, bar, detail, action });
            Shown += delegate { new Thread(Run) { IsBackground = true }.Start(); };
        }

        void Ui(Action a) { if (!IsDisposed) try { BeginInvoke(a); } catch (InvalidOperationException) { } }

        void Run()
        {
            string file = Path.Combine(Path.GetTempPath(), "EVE-Tool-Setup-" + DateTime.Now.Ticks + ".exe");
            string error = "";
            for (int i = 0; i < Sources.Length && !cancel; i++)
            {
                string src = Sources[i];
                string host = new Uri(src).Host;
                bool first = i == 0;
                Ui(delegate
                {
                    status.Text = first ? T("正在从 GitHub 下载安装包…", "Downloading the installer from GitHub…") : T("GitHub 连不上，改用镜像下载…", "GitHub unreachable, trying a mirror…");
                    detail.Text = host;
                    bar.Style = ProgressBarStyle.Marquee;
                });
                try
                {
                    Download(src, file, host);
                    if (cancel) break;
                    Ui(delegate { status.Text = T("下载完成，正在启动安装程序…", "Downloaded, starting the installer…"); bar.Style = ProgressBarStyle.Blocks; bar.Value = 100; });
                    Process.Start(file);
                    Thread.Sleep(800);
                    Ui(Close);
                    return;
                }
                catch (Exception e)
                {
                    error = host + "：" + e.Message;
                    try { File.Delete(file); } catch { }
                }
            }
            if (cancel) return;
            Ui(delegate
            {
                failed = true;
                status.Text = T("下载失败", "Download failed");
                detail.Text = error + "\n" + T("可以点「打开网页」手动下载安装包。", "Click \"Open page\" to download the installer manually.");
                bar.Style = ProgressBarStyle.Blocks;
                bar.Value = 0;
                action.Text = T("打开网页", "Open page");
            });
        }

        void Download(string url, string file, string host)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.UserAgent = "EVE-Tool-Downloader/1.0";
            req.Timeout = 20000;
            req.ReadWriteTimeout = 30000;
            req.AllowAutoRedirect = true;
            using (var res = (HttpWebResponse)req.GetResponse())
            using (var input = res.GetResponseStream())
            using (var output = File.Create(file))
            {
                long total = res.ContentLength, got = 0;
                var buf = new byte[81920];
                int n, last = -1;
                var head = new byte[2];
                while ((n = input.Read(buf, 0, buf.Length)) > 0)
                {
                    if (cancel) return;
                    if (got == 0 && n >= 2) { head[0] = buf[0]; head[1] = buf[1]; }
                    output.Write(buf, 0, n);
                    got += n;
                    int pct = total > 0 ? (int)(got * 100 / total) : -1;
                    if (pct != last)
                    {
                        last = pct;
                        long g = got, t = total;
                        Ui(delegate
                        {
                            if (pct >= 0) { bar.Style = ProgressBarStyle.Blocks; bar.Value = Math.Min(100, pct); }
                            detail.Text = host + "  ·  " + Mb(g) + (t > 0 ? " / " + Mb(t) : "");
                        });
                    }
                }
                // 必须是完整的 Windows 程序（镜像出错时可能返回网页）
                if (head[0] != 'M' || head[1] != 'Z' || got < 512 * 1024 || (total > 0 && got != total))
                    throw new InvalidDataException(T("下载的文件不完整", "incomplete download"));
            }
        }

        static string Mb(long b) { return (b / 1048576.0).ToString("0.0") + " MB"; }
    }
}
